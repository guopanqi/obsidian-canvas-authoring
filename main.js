const { Plugin, Component, Notice, Menu, Modal, Setting, PluginSettingTab, setIcon, setTooltip, MarkdownRenderer, htmlToMarkdown } = require('obsidian');

const DEFAULT_SETTINGS = { claudeCanvasTheme: true };

// Canvas's runtime API is internal; keep access to it in this small adapter.
module.exports = class CanvasAuthoring extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new CanvasAuthoringSettingTab(this.app, this));
    this.updateThemeClass();
    this.patched = new Map();
    this.controls = new Map();
    this.creationMenus = new Map();
    this.pasteHandlers = new Map();
    this.connectionUpdates = new Map();
    this.editorObservers = new Map();
    this.menuObservers = new Map();
    this.fontBreakpoints = new Map();
    this.editorFrames = new WeakSet();
    this.addCommand({id: 'copy-node-link', name: 'Copy node link', checkCallback: checking => {
      const canvas = this.canvas();
      const node = canvas?.selection.size === 1 ? [...canvas.selection][0] : null;
      if (!node || !canvas.nodes.has(node.id)) return false;
      if (!checking) this.copyNodeLink(canvas, node);
      return true;
    }});
    this.registerDomEvent(document, 'click', event => {
      if (event.button !== 0 || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a.internal-link');
      const href = link?.getAttribute('data-href') || link?.getAttribute('href');
      if (!href || !/(?:^|\.canvas)#node=[^#]+$/.test(href)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      let source = this.app.workspace.activeLeaf?.view?.file?.path;
      this.app.workspace.iterateAllLeaves(leaf => {
        if (leaf.view?.containerEl?.contains(link)) source = leaf.view.file?.path;
      });
      this.jumpToNode(href, source || '');
    }, true);
    this.addCommand({id: 'copy-content', name: 'Copy', checkCallback: checking => {
      const canvas = this.canvas();
      if (!this.canCopyContent(canvas)) return false;
      if (!checking) this.copyContent(canvas);
      return true;
    }});
    this.addCommand({id: 'copy-selection', name: 'Copy node data', checkCallback: checking => {
      const canvas = this.canvas();
      if (!this.canCopy(canvas)) return false;
      if (!checking) this.copySelection(canvas);
      return true;
    }});
    this.registerDomEvent(document, 'copy', event => {
      const canvas = this.canvas();
      if (!this.canCopyContent(canvas) || !event.clipboardData || document.activeElement !== canvas.wrapperEl) return;
      const data = this.selectionData(canvas);
      event.preventDefault(); event.stopImmediatePropagation();
      // Native Canvas data stays available for internal paste. External apps get content.
      if (!data.nodes.length) {
        event.clipboardData.setData('text/plain', this.selectedEdgeText(canvas));
        return;
      }
      const payload = this.nativeClipboardData(data);
      event.clipboardData.setData('obsidian/canvas', JSON.stringify(payload));
      const plain = this.simpleClipboardText(data);
      event.clipboardData.setData('text/plain', plain);
      // File bodies and image pixels require asynchronous vault reads.
      event.clipboardData.setData('text/html', this.clipboardHtml(payload, `<pre>${this.escapeHtml(plain)}</pre>`));
      this.copyContent(canvas, data);
    }, true);
    this.registerDomEvent(document, 'paste', event => {
      const canvas = this.canvas();
      if (!canvas || canvas.readonly || document.activeElement !== canvas.wrapperEl || event.defaultPrevented) return;
      if (event.clipboardData?.getData('obsidian/canvas')) return; // Let native paste handle it.
      const html = event.clipboardData?.getData('text/html') || '';
      const match = html.match(/<!--canvas-authoring:([A-Za-z0-9+/=]+)-->/);
      if (!match) return;
      event.preventDefault(); event.stopImmediatePropagation();
      try {
        const data = this.parseGroup(new TextDecoder().decode(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0))));
        // Same behavior as native paste: preserve the selected fragment's layout at the viewport center.
        const box = canvas.getViewportBBox();
        const minX = Math.min(...data.nodes.map(n => n.x)), minY = Math.min(...data.nodes.map(n => n.y));
        const maxX = Math.max(...data.nodes.map(n => n.x + n.width)), maxY = Math.max(...data.nodes.map(n => n.y + n.height));
        const added = canvas.importData(canvas.cloneData(data, {
          x: (box.minX + box.maxX - minX - maxX) / 2,
          y: (box.minY + box.maxY - minY - maxY) / 2
        }), false);
        canvas.deselectAll(); for (const node of added) canvas.select(node);
        canvas.requestSave(); this.attach();
      } catch (error) { console.error('Canvas Authoring: node paste failed', error); new Notice(`Could not paste nodes: ${error.message}`); }
    }, true);
    this.addCommand({id: 'copy-group', name: 'Copy group data', checkCallback: checking => {
      const canvas = this.canvas(), group = this.selectedGroup(canvas);
      if (!group) return false;
      if (!checking) this.copyGroup(canvas, group);
      return true;
    }});
    this.addCommand({id: 'paste-group', name: 'Paste content from clipboard', checkCallback: checking => {
      const canvas = this.canvas();
      if (!canvas || canvas.readonly) return false;
      if (!checking) this.pasteGroup(canvas);
      return true;
    }});
    this.addCommand({id: 'import-mermaid', name: 'Import Mermaid diagram', checkCallback: checking => {
      const canvas = this.canvas();
      if (!canvas || canvas.readonly) return false;
      if (!checking) this.importMermaid(canvas);
      return true;
    }});
    this.addCommand({id: 'duplicate-selection', name: 'Duplicate selection',
      hotkeys: [{modifiers: ['Mod'], key: 'd'}],
      checkCallback: checking => {
        const canvas = this.canvas();
        if (!this.canDuplicate(canvas)) return false;
        if (!checking) this.duplicate(canvas);
        return true;
      }
    });
    this.addCommand({id: 'add-annotation', name: 'Add annotation', checkCallback: checking => {
      const canvas = this.canvas();
      if (!canvas || canvas.readonly) return false;
      if (!checking) this.addAnnotation(canvas);
      return true;
    }});
    for (const [id, name, kind] of [
      ['add-child', 'Add child node', 'child'],
      ['add-sibling', 'Add sibling node', 'sibling'],
      ['add-next', 'Add follow-up node', 'next']
    ]) this.addCommand({ id, name, checkCallback: checking => {
      const canvas = this.canvas();
      const node = this.selected(canvas);
      if (!node) return false;
      if (!checking) this.add(canvas, node, kind);
      return true;
    }});
    this.registerDomEvent(document, 'keydown', event => {
      if (event.isComposing) return;
      if (event.target.closest?.('input, textarea, [contenteditable="true"], .cm-editor')) return;
      // Canvas has its own keyboard scope. Handle duplication before that scope
      // consumes the event; keep the command as a discoverable menu entry.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
        const canvas = this.canvas();
        if (!this.canDuplicate(canvas)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        this.duplicate(canvas);
        return;
      }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const canvas = this.canvas(), node = this.selected(canvas);
      if (!node || !['Tab', 'Enter'].includes(event.key)) return;
      if (event.key === 'Enter' && !this.parent(canvas, node)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      this.add(canvas, node, event.key === 'Tab' ? 'child' : 'sibling');
    }, true);
    this.registerEvent(this.app.workspace.on('canvas:selection-menu', (menu, canvas) => {
      if (this.canCopyContent(canvas)) menu.addItem(item => item.setTitle('Copy').setIcon('copy').setSection('clipboard')
        .onClick(() => this.copyContent(canvas))); 
      if (this.canCopy(canvas)) menu.addItem(item => item.setTitle('Copy as Canvas JSON').setIcon('braces').setSection('clipboard')
        .onClick(() => this.copySelection(canvas)));
      if (this.canDuplicate(canvas)) menu.addItem(item => item.setTitle('Duplicate').setIcon('copy-plus').setSection('action')
        .onClick(() => this.duplicate(canvas)));
    }));
    this.registerEvent(this.app.workspace.on('canvas:node-connection-drop-menu', (menu, source, edge) => {
      const canvas = source.canvas;
      if (canvas.readonly) return;
      const {x, y} = edge.to.node;
      const side = edge.to.side;
      menu.addItem(item => item.setTitle('Add annotation').setSection('action').setIcon('sticky-note').onClick(() => {
        const node = this.addAnnotation(canvas, {x, y}, side);
        // The native menu removes its unfinished edge on hide. Give the completed
        // connection a new ID so that cancellation cleanup cannot remove it.
        const connection = {...edge.getData(), id: crypto.randomUUID().replaceAll('-', '').slice(0, 16), toNode: node.id};
        canvas.removeEdge(edge);
        const data = canvas.getData();
        data.edges.push(connection);
        canvas.importData(data);
        canvas.requestSave();
        this.attach();
      }));
    }));
    this.registerEvent(this.app.workspace.on('canvas:node-menu', (menu, node) => {
      const canvas = node.canvas || this.canvas();
      const isGroup = node.getData().type === 'group';

      if (this.canDuplicate(canvas)) menu.addItem(item => item.setTitle('Duplicate').setIcon('copy-plus').setSection('action')
        .onClick(() => this.duplicate(canvas)));
      if (!isGroup && !canvas.readonly) {
        const branches = [
          ['Add child card (Tab)', 'child', 'git-branch'],
          ...(this.parent(canvas, node) ? [['Add sibling card (Enter)', 'sibling', 'git-fork']] : [])
        ];
        const addBranches = target => {
          for (const [title, kind, icon] of branches) {
            target.addItem(item => item.setTitle(title).setIcon(icon).setSection('action')
              .onClick(() => this.add(canvas, node, kind)));
          }
        };
        this.addSubmenu(menu, 'Mind map', 'git-branch', addBranches);
        menu.addItem(item => item.setTitle('Add follow-up card').setIcon('arrow-right').setSection('action')
          .onClick(() => this.add(canvas, node, 'next')));
      }

      const selection = canvas.selection.has(node) ? canvas.selection : [node];
      menu.addItem(item => item.setTitle('Copy').setIcon('copy').setSection('clipboard')
        .onClick(() => this.copyContent(canvas, this.selectionData(canvas, selection))));
      menu.addItem(item => item.setTitle(isGroup ? 'Copy link to group' : 'Copy link to card').setIcon('link').setSection('clipboard')
        .onClick(() => this.copyNodeLink(canvas, node)));
      menu.addItem(item => item.setTitle('Copy as Canvas JSON').setIcon('braces').setSection('clipboard')
        .onClick(() => isGroup ? this.copyGroup(canvas, node) : this.copySelection(canvas, selection)));
    }));
    this.registerInterval(window.setInterval(() => this.attach(), 250));
    this.attach();
  }
  addSubmenu(menu, title, icon, populate) {
    menu.addItem(item => {
      item.setTitle(title).setIcon(icon).setSection('action');
      const submenu = item.setSubmenu?.();
      if (submenu) populate(submenu);
      else item.onClick(event => {
        const fallback = new Menu();
        populate(fallback);
        fallback.showAtPosition({x: event.clientX, y: event.clientY});
      });
    });
  }
  nodeLink(canvas, node) {
    const file = canvas.view?.file;
    if (!file?.path) throw new Error('Save the canvas first.');
    const data = node.getData();
    const title = (data.label || data.text?.split('\n').find(line => line.trim()) || data.file || data.url || 'View node')
      .replace(/[#*|\[\]\r\n]/g, '').trim().slice(0, 60) || 'View node';
    return `[[${file.path}#node=${encodeURIComponent(node.id)}|${title}]]`;
  }
  async copyNodeLink(canvas, node) {
    try {
      await navigator.clipboard.writeText(this.nodeLink(canvas, node));
      new Notice('Node link copied. Paste it into a text card or note.');
    } catch (error) { new Notice(`Could not copy the node link: ${error.message}`); }
  }
  async jumpToNode(href, sourcePath) {
    try {
      const split = href.lastIndexOf('#node=');
      const path = href.slice(0, split), id = decodeURIComponent(href.slice(split + 6));
      const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getAbstractFileByPath(sourcePath);
      if (!file || file.extension !== 'canvas') throw new Error('The target canvas could not be found.');
      // Check before navigating so a deleted target does not move the user's view.
      let liveData;
      this.app.workspace.iterateAllLeaves(leaf => {
        if (leaf.view?.file?.path === file.path && leaf.view.canvas) liveData = leaf.view.canvas.getData();
      });
      const data = liveData || JSON.parse(await this.app.vault.cachedRead(file));
      if (!data.nodes?.some(n => n.id === id)) throw new Error('The linked node no longer exists.');
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf.view?.file?.path !== file.path) await leaf.openFile(file);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (leaf.view?.file?.path !== file.path) throw new Error('Navigation canceled because the active canvas changed.');
        const canvas = leaf.view?.canvas, node = canvas?.nodes.get(id);
        if (node) {
          canvas.deselectAll(); canvas.select(node);
          canvas.zoomToBbox(node.getBBox());
          canvas.wrapperEl?.focus();
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 50));
      }
      throw new Error('The target canvas has not loaded. Try again.');
    } catch (error) { new Notice(`Could not open the linked node: ${error.message}`); }
  }
  canvas() { return this.app.workspace.activeLeaf?.view?.canvas; }
  selected(canvas) {
    if (!canvas || canvas.selection.size !== 1) return null;
    const node = [...canvas.selection][0];
    return node.getData?.().type === 'text' || node.getData?.().type === 'file' ? node : null;
  }
  selectedGroup(canvas) {
    if (!canvas || canvas.selection.size !== 1) return null;
    const node = [...canvas.selection][0];
    return node.getData?.().type === 'group' ? node : null;
  }
  canCopy(canvas) {
    if (!canvas || ![...canvas.selection].some(n => canvas.nodes.has(n.id))) return false;
    return !document.activeElement?.closest?.('input, textarea, [contenteditable="true"], .cm-editor');
  }
  selectedEdgeText(canvas) {
    return [...canvas.selection].filter(item => canvas.edges.has(item.id))
      .map(edge => edge.getData().label || '').filter(Boolean).join('\n\n');
  }
  canCopyContent(canvas) {
    if (this.canCopy(canvas)) return true;
    if (!canvas || document.activeElement?.closest?.('input, textarea, [contenteditable="true"], .cm-editor')) return false;
    return Boolean(this.selectedEdgeText(canvas));
  }
  selectionData(canvas, selected = canvas.selection) {
    const data = structuredClone(canvas.getData());
    const ids = new Set([...selected].filter(n => canvas.nodes.has(n.id)).map(n => n.id));
    const groups = data.nodes.filter(n => ids.has(n.id) && n.type === 'group');
    const nodes = data.nodes.filter(n => ids.has(n.id) || groups.some(g => n.x >= g.x && n.y >= g.y &&
      n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height));
    const included = new Set(nodes.map(n => n.id));
    return {nodes, edges: data.edges.filter(e => included.has(e.fromNode) && included.has(e.toNode))};
  }
  groupData(canvas, group) { return this.selectionData(canvas, [group]); }
  escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  }
  nativeClipboardData(data) {
    if (!data.nodes.length) throw new Error('Select at least one node.');
    return {...data, center: {
      x: (Math.min(...data.nodes.map(n => n.x)) + Math.max(...data.nodes.map(n => n.x + n.width))) / 2,
      y: (Math.min(...data.nodes.map(n => n.y)) + Math.max(...data.nodes.map(n => n.y + n.height))) / 2
    }};
  }
  clipboardHtml(data, content) {
    // HTML carries the native fragment invisibly when the system image clipboard cannot carry
    // Obsidian's private MIME type. External plain text never contains JSON.
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return `<!--canvas-authoring:${btoa(binary)}--><div>${content}</div>`;
  }
  clipboardOrder(data) {
    const groups = data.nodes.filter(n => n.type === 'group');
    const parents = new Map();
    for (const node of data.nodes) {
      const parent = groups.filter(g => g.id !== node.id && g.width * g.height > node.width * node.height &&
        node.x >= g.x && node.y >= g.y && node.x + node.width <= g.x + g.width && node.y + node.height <= g.y + g.height)
        .sort((a,b) => a.width*a.height - b.width*b.height || a.id.localeCompare(b.id))[0];
      parents.set(node.id, parent?.id);
    }
    const result = [];
    const walk = (parent, depth) => {
      const children = data.nodes.filter(n => parents.get(n.id) === parent).sort((a,b) => a.y-b.y || a.x-b.x || a.id.localeCompare(b.id));
      for (const node of children) { result.push({node, depth}); if (node.type === 'group') walk(node.id, depth+1); }
    };
    walk(undefined, 0); return result;
  }
  fileLink(path, subpath = '') {
    return `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(path + subpath)}`;
  }
  simpleClipboardText(data) {
    return this.clipboardOrder(data).map(({node:n, depth}) => {
      if (n.type === 'group') return `${'#'.repeat(Math.min(depth+2,6))} ${n.label || 'Group'}`;
      if (n.type === 'text') return n.text;
      if (n.type === 'link') return n.url;
      return `[${n.file.split('/').pop()}](${this.fileLink(n.file, n.subpath)})`;
    }).filter(Boolean).join('\n\n');
  }
  async noteText(file, subpath) {
    const text = await this.app.vault.cachedRead(file);
    if (!subpath || subpath === '#') return text;
    const ref = decodeURIComponent(subpath.replace(/^#/, ''));
    const cache = this.app.metadataCache.getFileCache(file);
    if (ref.startsWith('^')) {
      const block = cache?.blocks?.[ref.slice(1)];
      if (!block) throw new Error(`Note block not found: ${subpath}`);
      return text.slice(block.position.start.offset, block.position.end.offset);
    }
    const headings = cache?.headings || [];
    const index = headings.findIndex(h => h.heading === ref);
    if (index < 0) throw new Error(`Note section not found: ${subpath}`);
    const start = headings[index];
    const end = headings.slice(index+1).find(h => h.level <= start.level);
    return text.slice(start.position.start.offset, end?.position.start.offset ?? text.length).trimEnd();
  }
  async imageData(file) {
    const mime = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',avif:'image/avif'}[file.extension.toLowerCase()];
    if (!mime) throw new Error(`Unsupported image format: ${file.extension}`);
    const bytes = await this.app.vault.readBinary(file);
    const blob = new Blob([bytes], {type:mime});
    const url = await new Promise((resolve,reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    });
    return {blob, url};
  }
  async pngBlob(blob) {
    if (blob.type === 'image/png') return blob;
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve,reject) => { image.onload=resolve; image.onerror=()=>reject(new Error('Could not decode the image.')); image.src=url; });
      const surface = document.createElement('canvas'); surface.width=image.naturalWidth; surface.height=image.naturalHeight;
      surface.getContext('2d').drawImage(image,0,0);
      return await new Promise((resolve,reject) => surface.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode the image.')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  async renderedMarkdown(text, source) {
    const element = document.createElement('div');
    await MarkdownRenderer.render(this.app, text, element, source, this);
    // Resource URLs are app-local; embed vault images for external rich-text paste.
    for (const image of element.querySelectorAll('img')) {
      const embed = image.closest('.internal-embed');
      const link = embed?.getAttribute('src') || image.getAttribute('data-href');
      if (link) {
        const file = this.app.metadataCache.getFirstLinkpathDest(link.split('#')[0], source);
        if (file && /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.extension)) image.src=(await this.imageData(file)).url;
      }
    }
    for (const a of element.querySelectorAll('a.internal-link')) {
      const link = a.getAttribute('data-href') || a.getAttribute('href');
      if (!link) continue;
      const [path,...fragment] = link.split('#');
      const file = path ? this.app.metadataCache.getFirstLinkpathDest(path,source) : this.app.vault.getAbstractFileByPath(source);
      if (file) a.href=this.fileLink(file.path,fragment.length ? '#'+fragment.join('#') : '');
    }
    return element.innerHTML;
  }
  async contentClipboard(data, source) {
    const plain=[],html=[];let image;
    for (const {node:n,depth} of this.clipboardOrder(data)) {
      if (n.type === 'group') {
        const level=Math.min(depth+2,6), title=n.label || 'Group';
        plain.push(`${'#'.repeat(level)} ${title}`);html.push(`<h${level}>${this.escapeHtml(title)}</h${level}>`);
      } else if (n.type === 'text') {
        plain.push(n.text);html.push(await this.renderedMarkdown(n.text,source));
      } else if (n.type === 'link') {
        plain.push(n.url);html.push(`<p><a href="${this.escapeHtml(n.url)}">${this.escapeHtml(n.url)}</a></p>`);
      } else if (n.type === 'file') {
        const file=this.app.vault.getAbstractFileByPath(n.file);
        if (!file) throw new Error(`File not found: ${n.file}`);
        if (/^(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.extension)) {
          const picture=await this.imageData(file);
          plain.push(`![${file.name}](${this.fileLink(file.path)})`);
          html.push(`<p><img src="${picture.url}" alt="${this.escapeHtml(file.name)}"></p>`);
          if (data.nodes.length===1) image=await this.pngBlob(picture.blob);
        } else if (file.extension.toLowerCase()==='md') {
          const text=await this.noteText(file,n.subpath);plain.push(text);html.push(await this.renderedMarkdown(text,file.path));
        } else {
          const url=this.fileLink(file.path,n.subpath);plain.push(`[${file.name}](${url})`);
          html.push(`<p><a href="${this.escapeHtml(url)}">${this.escapeHtml(file.name)}</a></p>`);
        }
      }
    }
    return {plain:plain.filter(Boolean).join('\n\n'),html:this.clipboardHtml(this.nativeClipboardData(data),html.join('\n')),image};
  }
  async copyContent(canvas, data = this.selectionData(canvas)) {
    try {
      if (!data.nodes.length) {
        const text=this.selectedEdgeText(canvas);
        if (text) await navigator.clipboard.writeText(text);
        return;
      }
      // Resolve the item lazily so clipboard permission is requested in the user gesture.
      const content=this.contentClipboard(data,canvas.view?.file?.path || '');
      const singleImage=data.nodes.length===1 && data.nodes[0].type==='file' && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(data.nodes[0].file);
      const formats={'text/html':content.then(c => new Blob([c.html],{type:'text/html'}))};
      if (singleImage) formats['image/png']=content.then(c => c.image);
      else formats['text/plain']=content.then(c => new Blob([c.plain],{type:'text/plain'}));
      await navigator.clipboard.write([new ClipboardItem(formats)]);
    } catch (error) { new Notice(`Could not copy content: ${error.message}`); }
  }
  async copySelection(canvas, selection) {
    try {
      const data = this.selectionData(canvas, selection);
      if (!data.nodes.length) throw new Error('Select at least one node.');
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      new Notice(`Copied ${data.nodes.length} ${data.nodes.length === 1 ? 'node' : 'nodes'} to the clipboard.`);
    } catch (error) { new Notice(`Could not copy: ${error.message}`); }
  }
  async copyGroup(canvas, group) {
    try {
      const data = this.groupData(canvas, group);
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      const references = data.nodes.filter(n => n.type === 'file').length;
      new Notice(`Copied the group and its contents${references ? ' (images and notes are file references)' : ''}`);
    } catch (error) {
      new Notice(`Could not copy the group: ${error.message}`);
    }
  }
  parseGroup(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    const data = JSON.parse(fenced ? fenced[1] : trimmed);
    const fail = message => { throw new Error(message); };
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) fail('Expected Canvas JSON with nodes and edges arrays.');
    const ids = new Set();
    for (const n of data.nodes) {
      if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id)) fail('Node ID is missing or duplicated.');
      ids.add(n.id);
      if (!['text', 'file', 'link', 'group'].includes(n.type)) fail('Unsupported node type.');
      if (![n.x, n.y, n.width, n.height].every(Number.isFinite) || n.width <= 0 || n.height <= 0) fail('Invalid node position or size.');
      const field = {text:'text', file:'file', link:'url', group:'label'}[n.type];
      if (n.type !== 'group' && typeof n[field] !== 'string') fail(`Node is missing ${field}`);
    }
    if (!data.nodes.length) fail('The clipboard contains no nodes.');
    const edgeIds = new Set();
    for (const e of data.edges) {
      if (!e || typeof e.id !== 'string' || edgeIds.has(e.id)) fail('Edge ID is missing or duplicated.');
      edgeIds.add(e.id);
      if (!ids.has(e.fromNode) || !ids.has(e.toNode)) fail('An edge references a node outside the selection or a missing node.');
      for (const key of ['fromSide', 'toSide']) if (e[key] !== undefined && !['top','right','bottom','left'].includes(e[key])) fail('Invalid edge side.');
      for (const key of ['fromEnd', 'toEnd']) if (e[key] !== undefined && !['none','arrow'].includes(e[key])) fail('Invalid arrow type.');
    }
    return data;
  }
  insertGroup(canvas, data, position) {
    if (canvas.readonly) throw new Error('The canvas is read-only.');
    const current = canvas.getData();
    const minX = Math.min(...data.nodes.map(n => n.x)), minY = Math.min(...data.nodes.map(n => n.y));
    // With no mouse position (command palette), append beneath the board.
    const target = position || {x: minX, y: current.nodes.length ? Math.max(...current.nodes.map(n => n.y + n.height)) + 100 : 0};
    const dx = target.x - minX;
    let dy = target.y - minY;
    const width = Math.max(...data.nodes.map(n => n.x + n.width)) - minX;
    const height = Math.max(...data.nodes.map(n => n.y + n.height)) - minY;
    // Reserve the entire incoming frame, including whitespace, against existing groups.
    let hits;
    do {
      hits = current.nodes.filter(n => target.x < n.x + n.width + 24 && target.x + width + 24 > n.x &&
        minY + dy < n.y + n.height + 24 && minY + dy + height + 24 > n.y);
      if (hits.length) dy = Math.max(...hits.map(n => n.y + n.height + 24)) - minY;
    } while (hits.length);
    const freshId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const remap = new Map(data.nodes.map(n => [n.id, freshId()]));
    const nodes = data.nodes.map(n => ({...n, id: remap.get(n.id), x: n.x + dx, y: n.y + dy}));
    const edges = data.edges.map(e => ({...e, id: freshId(), fromNode: remap.get(e.fromNode), toNode: remap.get(e.toNode)}));
    const added = canvas.importData({nodes, edges}, false);
    canvas.deselectAll();
    for (const node of added) canvas.select(node);
    canvas.requestSave();
    this.attach();
    canvas.zoomToSelection?.();
  }
  async pasteGroup(canvas, position) {
    try {
      const data = this.parseGroup(await navigator.clipboard.readText());
      this.insertGroup(canvas, data, position);
      new Notice('Pasted as new content.');
    } catch (error) {
      new Notice(`Could not paste Canvas content: ${error.message}`);
    }
  }
  importMermaid(canvas, position) {
    const modal = new Modal(this.app);
    modal.setTitle('Import Mermaid diagram');
    modal.modalEl.classList.add('canvas-authoring-mermaid-modal');
    modal.contentEl.createEl('p', {text: 'Paste a flowchart or mind map, with or without Mermaid code fences.'});
    const columns = modal.contentEl.createDiv({cls: 'canvas-authoring-mermaid-columns'});
    const input = columns.createEl('textarea', {
      attr: {'aria-label': 'Mermaid source', rows: '14', spellcheck: 'false'}
    });
    const preview = columns.createDiv({
      cls: 'canvas-authoring-mermaid-preview',
      attr: {'aria-label': 'Mermaid preview', role: 'region'}
    });
    const message = modal.contentEl.createDiv({attr: {role: 'status', 'aria-live': 'polite'}});
    message.textContent = 'Paste Mermaid source to see a preview.';
    const alert = modal.contentEl.createDiv({
      cls: 'canvas-authoring-mermaid-error', attr: {role: 'alert', hidden: ''}
    });
    const errorTitle = alert.createEl('strong');
    const errorDetail = alert.createDiv();
    const showError = (title, detail) => {
      message.hidden = true;
      alert.hidden = false;
      errorTitle.textContent = title;
      errorDetail.textContent = detail;
    };
    let revision = 0;
    let timer;
    let component;
    let pending;
    let importButton;
    modal.onClose = () => {
      revision++;
      clearTimeout(timer);
      if (component) this.removeChild(component);
      component = undefined;
    };
    new Setting(modal.contentEl).addButton(button => {
      importButton = button.setButtonText('Import').setCta().setDisabled(true).onClick(() => {
        if (!pending) return;
        try {
          this.insertGroup(canvas, pending, position);
          modal.close();
          new Notice('Mermaid diagram imported.');
        } catch (error) {
          showError('Import failed', error.message);
        }
      });
    });

    input.addEventListener('input', () => {
      const current = ++revision;
      clearTimeout(timer);
      pending = undefined;
      importButton.setDisabled(true);
      if (component) this.removeChild(component);
      component = undefined;
      preview.empty();
      alert.hidden = true;
      errorDetail.textContent = '';
      message.hidden = false;
      input.removeAttribute('aria-invalid');
      const source = input.value.trim();
      message.textContent = source ? 'Checking Mermaid source…' : 'Paste Mermaid source to see a preview.';
      if (!source) return;
      timer = setTimeout(async () => {
        let kind = '';
        try {
          const body = unwrapMermaid(source);
          const direction = body.match(/^(?:flowchart|graph)[ \t]+(TB|TD|BT|LR|RL)\b/)?.[1];
          const mindMap = /^mindmap\b/.test(body);
          kind = mindMap ? 'Mind map' : direction ? `Flowchart (${direction})` : '';
          const data = this.parseGroup(JSON.stringify(mindMap ? mindMapToCanvas(body) : mermaidToCanvas(body)));
          message.textContent = `${kind} · Rendering preview…`;
          let matched = false;
          if (!mindMap) {
            const host = preview.createDiv({cls: 'markdown-rendered canvas-authoring-mermaid-measure'});
            component = new Component();
            this.addChild(component);
            const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)));
            await MarkdownRenderer.render(this.app, `${fence}mermaid\n${body}\n${fence}`, host, canvas.view.file?.path || '', component);
            if (current !== revision) return;
            matched = await this.applyRenderedMermaidLayout(host, direction, data);
            if (current !== revision) return;
            const svg = host.querySelector('.mermaid svg');
            const renderError = host.textContent.trim().slice(0, 240);
            this.removeChild(component);
            component = undefined;
            host.remove();
            if (!matched && !svg?.querySelector('g.pele-node, g.node')) {
              throw new Error(renderError || 'Could not render a Mermaid flowchart.');
            }
          }
          renderCanvasImportPreview(preview, data);
          pending = data;
          message.textContent = `${kind} · ${data.nodes.length} cards · ${data.edges.length} links` +
            (!mindMap && !matched ? ' · Using automatic Canvas placement.' : '');
          importButton.setDisabled(false);
        } catch (error) {
          if (current !== revision) return;
          input.setAttribute('aria-invalid', 'true');
          showError(kind ? `${kind}: preview unavailable` : 'Mermaid input could not be read', error.message);
        }
      }, 300);
    });
    modal.open();
    input.focus();
  }
  async applyRenderedMermaidLayout(host, direction, data) {
    const doc = host.ownerDocument;
    try {
      // Mermaid can finish after MarkdownRenderer resolves.
      for (let attempt = 0; attempt < 30 && host.isConnected; attempt++) {
        const svg = host.querySelector('.mermaid svg');
        const matrix = svg?.getScreenCTM?.();
        const boxes = new Map();
        if (matrix) {
          const inverse = matrix.inverse();
          const byId = new Map(data.nodes.map(node => [node.id, node]));
          // Pele uses data-id; older Mermaid renderers encode the ID in the element ID.
          for (const el of svg.querySelectorAll('g.pele-node[data-id], g.node')) {
            const id = el.getAttribute('data-id') || el.id.match(/^flowchart-(.+)-[0-9]+$/)?.[1];
            const transform = el.getScreenCTM?.();
            if (!byId.has(id) || !transform) continue;
            const box = el.getBBox();
            const coordinates = inverse.multiply(transform);
            const start = new doc.defaultView.DOMPoint(box.x, box.y).matrixTransform(coordinates);
            const end = new doc.defaultView.DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(coordinates);
            const bounds = {x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y};
            if (Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0) boxes.set(id, bounds);
          }
        }
        if (boxes.size === data.nodes.length) {
          // Scale the whole diagram together to leave room for Canvas card padding.
          const scale = Math.max(1, ...[...boxes.values()].map(box => Math.max(54 / box.height, 88 / box.width)));
          const centers = new Map();
          for (const node of data.nodes) {
            const box = boxes.get(node.id);
            for (const key of ['x', 'y', 'width', 'height']) node[key] = box[key] * scale;
            centers.set(node.id, {x: node.x + node.width / 2, y: node.y + node.height / 2});
          }
          const horizontal = direction === 'LR' || direction === 'RL';
          for (const edge of data.edges) {
            if (edge.fromNode === edge.toNode) continue;
            const from = centers.get(edge.fromNode);
            const to = centers.get(edge.toNode);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const across = horizontal ? Math.abs(dx) >= 1 : Math.abs(dy) < 1;
            [edge.fromSide, edge.toSide] = across
              ? (dx >= 0 ? ['right', 'left'] : ['left', 'right'])
              : (dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']);
          }
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.warn('Canvas Authoring: Mermaid layout unavailable', error);
    }
    return false;
  }
  canDuplicate(canvas) {
    if (!canvas || canvas.readonly || !canvas.selection.size) return false;
    const active = document.activeElement;
    if (active?.closest?.('input, textarea, [contenteditable="true"], .cm-editor')) return false;
    return [...canvas.selection].some(item => canvas.nodes.has(item.id));
  }
  duplicate(canvas) {
    if (!this.canDuplicate(canvas)) return;
    const data = structuredClone(canvas.getData());
    const ids = new Set([...canvas.selection].filter(item => canvas.nodes.has(item.id)).map(item => item.id));
    // Groups are spatial frames in JSON Canvas. Include only fully enclosed nodes.
    const groups = data.nodes.filter(n => ids.has(n.id) && n.type === 'group');
    for (const n of data.nodes) {
      if (groups.some(g => n.x >= g.x && n.y >= g.y &&
          n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height)) ids.add(n.id);
    }
    const originals = data.nodes.filter(n => ids.has(n.id));
    // Duplicate in place with a small offset toward the viewport center.
    // Overlap is intentional: finding empty space can send large groups far offscreen.
    const viewport = canvas.getViewportBBox();
    const centerX = (Math.min(...originals.map(n => n.x)) + Math.max(...originals.map(n => n.x + n.width))) / 2;
    const centerY = (Math.min(...originals.map(n => n.y)) + Math.max(...originals.map(n => n.y + n.height))) / 2;
    let dx = centerX > (viewport.minX + viewport.maxX) / 2 ? -32 : 32;
    let dy = centerY > (viewport.minY + viewport.maxY) / 2 ? -32 : 32;
    const hasGroups = originals.some(n => n.type === 'group');
    if (hasGroups) {
      // A group captures nodes by position: its copied footprint must stay clear.
      const minX = Math.min(...originals.map(n => n.x)), minY = Math.min(...originals.map(n => n.y));
      const maxX = Math.max(...originals.map(n => n.x + n.width)), maxY = Math.max(...originals.map(n => n.y + n.height));
      const gap = 40;
      const candidates = data.nodes.flatMap(n => [
        {dx: n.x + n.width + gap - minX, dy: 0},
        {dx: n.x - gap - maxX, dy: 0},
        {dx: 0, dy: n.y + n.height + gap - minY},
        {dx: 0, dy: n.y - gap - maxY}
      ]).filter(offset => !data.nodes.some(n =>
        minX + offset.dx < n.x + n.width + gap && maxX + offset.dx + gap > n.x &&
        minY + offset.dy < n.y + n.height + gap && maxY + offset.dy + gap > n.y));
      candidates.sort((a, b) => a.dx * a.dx + a.dy * a.dy - b.dx * b.dx - b.dy * b.dy);
      if (!candidates.length) throw new Error('Could not find space for the group duplicate.');
      ({dx, dy} = candidates[0]);
    }
    const freshId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const remap = new Map(originals.map(n => [n.id, freshId()]));
    const copies = originals.map(n => ({...n, id: remap.get(n.id), x: n.x + dx, y: n.y + dy}));
    // Copy internal edges only, regardless of arrow type. Never graft onto an external flow.
    const edges = data.edges.filter(e => ids.has(e.fromNode) && ids.has(e.toNode))
      .map(e => ({...e, id: freshId(), fromNode: remap.get(e.fromNode), toNode: remap.get(e.toNode)}));
    data.nodes.push(...copies); data.edges.push(...edges);
    canvas.importData(data);
    canvas.deselectAll();
    for (const n of copies) {
      const node = canvas.nodes.get(n.id);
      if (node) canvas.select(node);
    }
    canvas.requestSave();
    if (hasGroups) canvas.panTo(centerX + dx, centerY + dy);
    this.attach();
  }
  isConnection(data) {
    // JSON Canvas defaults: fromEnd=none, toEnd=arrow.
    return (data.fromEnd ?? 'none') === 'none' && (data.toEnd ?? 'arrow') === 'none';
  }
  parent(canvas, node) {
    const incoming = [...canvas.edges.values()].filter(e => {
      const d = e.getData();
      return d.toNode === node.id && this.isConnection(d);
    });
    return incoming.length === 1 ? canvas.nodes.get(incoming[0].getData().fromNode) : null;
  }
  add(canvas, source, kind, direction = 'right') {
    if (!canvas) return;
    if (kind === 'sibling') {
      const sibling = source;
      source = this.parent(canvas, sibling);
      if (source) {
        const edge = [...canvas.edges.values()].find(e => {
          const d = e.getData();
          return d.fromNode === source.id && d.toNode === sibling.id && this.isConnection(d);
        });
        direction = edge.getData().fromSide;
      }
      if (!source) { new Notice('Select a node with exactly one arrowless incoming connection to add a sibling.'); return; }
      kind = 'child';
    }
    const data = canvas.getData();
    const original = source.getData();
    const child = kind === 'child';
    const width = child ? Math.max(200, Math.min(260, original.width * .85)) : original.width;
    const height = child ? 80 : Math.max(100, original.height);
    const gap = child ? 80 : 100;
    const vertical = direction === 'top' || direction === 'bottom';
    let x = vertical ? original.x + (original.width - width) / 2 : direction === 'left' ? original.x - width - gap : original.x + original.width + gap;
    let y = !vertical ? original.y : direction === 'top' ? original.y - height - gap : original.y + original.height + gap;
    while (data.nodes.some(n => n.type !== 'group' && x < n.x + n.width + 24 && x + width + 24 > n.x && y < n.y + n.height + 24 && y + height + 24 > n.y)) {
      const obstacles = data.nodes.filter(n => n.type !== 'group' && x < n.x + n.width + 24 && x + width + 24 > n.x && y < n.y + n.height + 24 && y + height + 24 > n.y);
      if (vertical) x = Math.max(...obstacles.map(n => n.x + n.width + 24));
      else y = Math.max(...obstacles.map(n => n.y + n.height + 24));
    }
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    data.nodes.push({ id, type: 'text', text: '', x, y, width, height, ...(original.color ? {color: original.color} : {}) });
    data.edges.push({ id: crypto.randomUUID().replaceAll('-', '').slice(0,16), fromNode: source.id, fromSide: direction, toNode: id, toSide: {right:'left', left:'right', top:'bottom', bottom:'top'}[direction], fromEnd: 'none', toEnd: child ? 'none' : 'arrow' });
    // importData updates the live canvas, including its native undo/save pipeline.
    canvas.importData(data);
    canvas.requestSave();
    window.setTimeout(() => {
      const node = canvas.nodes.get(id);
      if (!node) return;
      canvas.deselectAll(); canvas.select(node);
      node.startEditing?.();
      this.attach();
    }, 0);
  }
  attach() {
    for (const [node, observer] of this.editorObservers) if (!node.canvas.nodes.has(node.id)) {
      observer.disconnect();
      this.editorObservers.delete(node);
    }
    this.releaseConnectionUpdates();
    this.app.workspace.iterateAllLeaves(leaf => {
      const canvas = leaf.view?.canvas;
      if (!canvas) return;
      for (const node of canvas.nodes.values()) this.paintNode(node);
      this.observeMenus(canvas, leaf.view);
      this.syncTransparentChoice(canvas, leaf.view);
      this.patchCreationMenu(canvas);
      this.patchTextPaste(canvas);
      this.syncStyleButton(canvas, leaf.view);
      this.syncControls(canvas);
      for (const edge of canvas.edges.values()) {
        if (this.patched.has(edge)) {
          this.draw(edge);
          continue;
        }
        const original = edge.updatePath;
        if (typeof original !== 'function') continue;
        const plugin = this;
        const wrapped = function(...args) {
          const result = original.apply(this, args);
          plugin.draw(this);
          return result;
        };
        edge.updatePath = wrapped;
        this.patched.set(edge, {original, wrapped});
        // Import creates edge objects before their SVG paths are mounted.
        // Native render will call the wrapped updatePath once the edge is ready.
        this.draw(edge);
      }
      for (const [edge, record] of this.patched) if (edge.canvas === canvas && !canvas.edges.has(edge.id)) {
        if (edge.updatePath === record.wrapped) edge.updatePath = record.original;
        this.patched.delete(edge);
      }
    });
  }
  patchTextPaste(canvas) {
    if (this.pasteHandlers.has(canvas) || typeof canvas.handlePaste !== 'function') return;
    const original = canvas.handlePaste;
    const plugin = this;
    const wrapped = function(event) {
      // Keep native clipboard decoding, attachment handling, URLs and undo behavior.
      // Only the native text branch calls createTextNode synchronously; convert its rich text here.
      if (event.defaultPrevented || this.readonly ||
          this.wrapperEl.ownerDocument.activeElement !== this.wrapperEl ||
          event.clipboardData?.getData('obsidian/canvas')) return original.call(this, event);
      const create = this.createTextNode;
      this.createTextNode = function(options) {
        const text = plugin.pastedText(event.clipboardData, options.text);
        const size = !options.size && text ? plugin.pastedTextSize(this, text) : options.size;
        const node = create.call(this, {...options, text, ...(size ? {size} : {})});
        if (!options.size && text) plugin.fitPastedMarkdown(this, node, text).catch(error => {
          console.error('Canvas Authoring: measuring pasted Markdown failed', error);
          new Notice('Content pasted. Could not measure the card height.');
        });
        return node;
      };
      try { return original.call(this, event); }
      finally { this.createTextNode = create; }
    };
    canvas.handlePaste = wrapped;
    this.pasteHandlers.set(canvas, {original, wrapped});
  }
  async fitPastedMarkdown(canvas, node, text) {
    const initial = node.getData();
    const child = node.child;
    if (!child?.previewMode?.renderer || typeof node.onResizeDblclick !== 'function') {
      throw new Error('This version of Obsidian does not support fitting the node height.');
    }
    const editing = Boolean(child.editMode);
    // Native edge fitting measures the live preview, not a separate Markdown copy.
    child.showPreview(true);
    node.setIsEditing(false);
    await new Promise(resolve => child.previewMode.renderer.onRendered(resolve));
    if (!canvas.nodes.has(node.id)) return;
    const current = node.getData();
    if (current.text !== text || current.width !== initial.width || current.height !== initial.height || child.editMode) return;
    node.onResizeDblclick({preventDefault() {}}, 'bottom');
    // Keep the existing automatic-paste bounds; manual edge fitting remains unrestricted.
    const height = Math.max(48, Math.min(600, node.getData().height));
    if (height !== node.getData().height) node.resize({width: initial.width, height});
    canvas.requestSave();
    if (editing && canvas.selection.size === 1 && canvas.selection.has(node)) node.startEditing();
  }
  pastedText(clipboard, plainText) {
    if (!clipboard) return plainText;
    const html = clipboard.getData('text/html');
    // Obsidian's editor marks its own source copies: the plain text already is Markdown.
    if (html.includes('<!-- obsidian -->') && clipboard.getData('text/plain')) return plainText;
    const markdown = clipboard.getData('text/markdown');
    if (markdown) return markdown;
    if (!html || this.app.vault.getConfig('autoConvertHtml') === false) return plainText;
    // Use the same public converter as Obsidian's editor, including its table rules.
    return htmlToMarkdown(html) || plainText;
  }
  pastedTextSize(canvas, text) {
    const doc = canvas.wrapperEl.ownerDocument;
    // Measure outside the zoomed canvas so zoom never changes the saved dimensions.
    // Use source text: it also leaves room for Markdown syntax while editing.
    const probe = doc.createElement('div');
    probe.className = 'canvas-authoring-text-measure';
    probe.textContent = text.replace(/\r\n?/g, '\n');
    doc.body.appendChild(probe);
    try {
      const style = doc.defaultView.getComputedStyle(probe);
      const fontSize = parseFloat(style.fontSize);
      const padding = 40;
      const measure = doc.createElement('canvas').getContext('2d');
      measure.font = style.font;
      const lines = probe.textContent.split('\n');
      const longest = lines.reduce((width, line) => Math.max(width, measure.measureText(line).width), 0);
      // Readable width tiers, expressed in the current font's full-width characters.
      const length = measure.measureText(probe.textContent.replace(/\s/g, '')).width / fontSize;
      const columns = length <= 60 ? 18 : length <= 400 ? 26 : 34;
      const width = Math.ceil(Math.max(200, Math.min(600, columns * fontSize + padding, longest + padding)));
      return {width, height: 48};
    } finally { probe.remove(); }
  }
  patchCreationMenu(canvas) {
    if (this.creationMenus.has(canvas)) return;
    const original = canvas.showCreationMenu;
    if (typeof original !== 'function') return;
    const plugin = this;
    const wrapped = function(menu, position, size) {
      const firstCreationIndex = Array.isArray(menu.items) ? menu.items.length : undefined;
      const result = original.call(this, menu, position, size);
      if (!this.readonly) {
        let annotation;
        menu.addItem(item => {
          annotation = item;
          item.setTitle('Add annotation').setSection('create').setIcon('sticky-note')
            .onClick(() => plugin.addAnnotation(this, position, undefined, size));
        });
        // Insert after the first native creation item (Add card), irrespective of locale.
        if (firstCreationIndex !== undefined && menu.items[firstCreationIndex]?.section === 'create') {
          const annotationIndex = menu.items.indexOf(annotation);
          if (annotationIndex > firstCreationIndex + 1) {
            menu.items.splice(annotationIndex, 1);
            menu.items.splice(firstCreationIndex + 1, 0, annotation);
          }
        }
        menu.addItem(item => item.setTitle('Import Mermaid diagram…').setIcon('git-branch').setSection('clipboard')
          .onClick(() => plugin.importMermaid(this, position)));
        menu.addItem(item => item.setTitle('Paste Canvas JSON').setIcon('clipboard-paste').setSection('clipboard')
          .onClick(() => plugin.pasteGroup(this, position)));
      }
      return result;
    };
    canvas.showCreationMenu = wrapped;
    this.creationMenus.set(canvas, {original, wrapped});
  }
  addAnnotation(canvas, position, anchor, size) {
    const box = canvas.getViewportBBox();
    const node = canvas.createTextNode({
      pos: position || {x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2},
      size, position: position ? anchor : 'center', text: '', focus: true
    });
    node.setData({...node.getData(), color: 'transparent'});
    canvas.requestSave();
    this.attach();
    return node;
  }
  paintNode(node) {
    let data = node.getData();
    const el = node.nodeEl;
    if (!el) return;
    const fontScale = data.type === 'text' ? (data.fontScale ?? 1) : 1;
    if (!Number.isFinite(fontScale) || fontScale <= 0) throw new Error('fontScale must be a positive number.');
    const baseFont = parseFloat(el.ownerDocument.defaultView.getComputedStyle(node.canvas.wrapperEl).getPropertyValue('--font-text-size'));
    const fontSize = `${baseFont * fontScale}px`;
    if (data.type === 'text') {
      el.classList.add('canvas-authoring-scaled-text');
      el.style.setProperty('--authoring-font-size', fontSize);
      el.style.setProperty('--font-text-size', fontSize);
      el.style.fontSize = fontSize;
      if (!this.fontBreakpoints.has(node)) {
        const original = node.updateBreakpoint;
        const wrapped = function() {
          const scale = this.getData().fontScale ?? 1;
          return original.call(this, this.canvas.zoom + Math.log2(scale) > this.canvas.zoomBreakpoint || this.isEditing);
        };
        node.updateBreakpoint = wrapped;
        this.fontBreakpoints.set(node, {original, wrapped});
      }
      node.updateBreakpoint();
    }
    el.classList.toggle('canvas-authoring-transparent', data.color === 'transparent');
    const emptyTransparentText = data.type === 'text' && data.color === 'transparent' && !data.text?.trim();
    el.classList.toggle('canvas-authoring-empty-text', emptyTransparentText);
    let placeholder = node.containerEl?.querySelector(':scope > .canvas-authoring-empty-placeholder');
    if (emptyTransparentText && node.containerEl && !placeholder) {
      placeholder = el.ownerDocument.createElement('div');
      placeholder.className = 'canvas-authoring-empty-placeholder';
      placeholder.textContent = 'Double-click to enter text';
      placeholder.setAttribute('aria-hidden', 'true');
      node.containerEl.appendChild(placeholder);
    }
    if (!emptyTransparentText) placeholder?.remove();
    // Observe editor creation before the next paint, rather than waiting for attach's timer.
    if (!this.editorObservers.has(node) && node.containerEl) {
      const observer = new el.ownerDocument.defaultView.MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(added => added.nodeType === 1 &&
            (added.matches('iframe.embed-iframe.is-controlled') || added.querySelector('iframe.embed-iframe.is-controlled'))))) {
          this.paintNode(node);
        }
      });
      observer.observe(node.containerEl, {childList: true, subtree: true});
      this.editorObservers.set(node, observer);
    }
    const fontColor = data.fontColor;
    el.classList.toggle('canvas-authoring-font-color', Boolean(fontColor));
    if (fontColor) el.style.setProperty('--authoring-font-color', /^[1-6]$/.test(fontColor) ? `var(--canvas-color-${fontColor})` : fontColor);
    else el.style.removeProperty('--authoring-font-color');
    // Canvas editors live in same-origin iframes; outer snippet selectors cannot reach them.
    const themeSurface = el.ownerDocument.defaultView.getComputedStyle(el).getPropertyValue('--claude-note-surface').trim();
    el.classList.toggle('canvas-authoring-editor-surface', Boolean(themeSurface));
    for (const iframe of el.querySelectorAll('iframe.embed-iframe.is-controlled')) {
      if (!this.editorFrames.has(iframe)) {
        this.editorFrames.add(iframe);
        this.registerDomEvent(iframe, 'load', () => this.paintNode(node));
      }
      const doc = iframe.contentDocument;
      if (!doc?.head) continue;
      let style = doc.getElementById('canvas-authoring-editor-surface');
      if (!themeSurface && fontScale === 1) { style?.remove(); iframe.classList.remove('canvas-authoring-surface-ready'); continue; }
      if (!style) {
        style = doc.createElement('style');
        style.id = 'canvas-authoring-editor-surface';
        doc.head.appendChild(style);
      }
      const surface = data.color === 'transparent' ? 'transparent' :
        el.ownerDocument.defaultView.getComputedStyle(node.containerEl).backgroundColor;
      const outerStyle = el.ownerDocument.defaultView.getComputedStyle(node.contentEl || node.containerEl);
      // The embed container's inherited color can be muted; resolve the actual
      // text token explicitly instead of copying that container color.
      const inkProbe = el.ownerDocument.createElement('span');
      inkProbe.style.color = 'var(--text-normal)';
      (node.contentEl || node.containerEl).appendChild(inkProbe);
      const ink = el.ownerDocument.defaultView.getComputedStyle(inkProbe).color;
      inkProbe.remove();
      const muted = fontColor ? ink : outerStyle.getPropertyValue('--text-muted').trim();
      const themeCss = `:root, body, .markdown-source-view, .cm-editor, .cm-content, .cm-line {
          color-scheme: light;
          --background-primary: ${surface} !important;
          --background-primary-alt: ${surface} !important;
          --text-normal: ${ink} !important;
          --text-muted: ${muted} !important;
          --text-faint: ${muted} !important;
          --h1-color: ${ink} !important; --h2-color: ${ink} !important;
          --h3-color: ${ink} !important; --h4-color: ${ink} !important;
          --h5-color: ${ink} !important; --h6-color: ${ink} !important;
          --bold-color: ${ink} !important; --italic-color: ${ink} !important;
        }
        html, body, .markdown-source-view, .cm-editor, .cm-scroller, .cm-gutters { background-color: transparent !important; }
        body, .markdown-source-view, .cm-content, .cm-line { color: ${ink} !important; }
        .cm-cursor { border-left-color: ${ink} !important; }`;
      const css = (themeSurface ? themeCss : '') + `\n:root, body, .markdown-source-view, .cm-editor { --font-text-size: ${fontSize} !important; }\n.markdown-source-view, .cm-content { font-size: ${fontSize} !important; }`;
      if (style.textContent !== css) style.textContent = css;
      iframe.classList.add('canvas-authoring-surface-ready');
    }
  }
  setFontColor(canvas, node, color) {
    const data = {...node.getData()};
    if (color) data.fontColor = color;
    else delete data.fontColor;
    node.setData(data);
    canvas.requestSave();
    this.paintNode(node);
  }
  fontScaleMenu(node, event) {
    const menu = new Menu();
    this.populateFontScales(menu, node);
    menu.showAtMouseEvent(event);
  }
  populateFontScales(menu, node) {
    for (const scale of [1, 3, 5]) menu.addItem(choice => choice.setTitle(`Font size: ${scale}×`).setSection('font-size')
      .setChecked((node.getData().fontScale ?? 1) === scale).onClick(() => {
        const data = {...node.getData()};
        if (scale === 1) delete data.fontScale;
        else data.fontScale = scale;
        node.setData(data);
        this.paintNode(node);
        node.render();
        node.canvas.requestSave();
        this.syncStyleButton(node.canvas, node.canvas.view);
      }));
  }
  toggleFontPalette(canvas, node, button) {
    const wasOpen = this.fontPalette?.button === button;
    this.fontPalette?.close();
    if (wasOpen) return;

    const doc = button.ownerDocument;
    const palette = doc.createElement('div');
    palette.className = 'canvas-submenu canvas-authoring-font-palette';
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', 'Text colors');

    const listeners = new AbortController();
    const {signal} = listeners;
    const close = () => {
      listeners.abort();
      palette.remove();
      button.classList.remove('is-active');
      button.setAttribute('aria-expanded', 'false');
      this.fontPalette = undefined;
    };
    this.fontPalette = {canvas, node, button, close};
    button.classList.add('is-active');
    button.setAttribute('aria-expanded', 'true');

    const colors = [['Default', undefined], ['Red', '1'], ['Orange', '2'], ['Yellow', '3'], ['Green', '4'], ['Cyan', '5'], ['Purple', '6']];
    let selected;
    for (const [name, color] of colors) {
      const swatch = doc.createElement('button');
      const active = node.getData().fontColor === color;
      swatch.type = 'button';
      swatch.className = 'canvas-authoring-font-swatch';
      swatch.setAttribute('aria-label', name);
      swatch.setAttribute('aria-pressed', String(active));
      swatch.style.setProperty('--swatch-ink', color ? `var(--canvas-color-${color})` : 'var(--text-normal)');
      if (typeof setTooltip === 'function') setTooltip(swatch, name, {placement: 'top'});
      if (active) selected = swatch;
      swatch.addEventListener('click', event => {
        event.stopPropagation();
        if (!canvas.readonly && this.selected(canvas) === node) this.setFontColor(canvas, node, color);
        close();
        button.focus({preventScroll: true});
      });
      palette.appendChild(swatch);
    }

    palette.addEventListener('pointerdown', event => event.stopPropagation());
    button.parentElement.appendChild(palette);
    doc.addEventListener('pointerdown', event => {
      if (!palette.contains(event.target) && !button.contains(event.target)) close();
    }, {capture: true, signal});
    doc.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus({preventScroll: true});
    }, {capture: true, signal});
    (selected || palette.firstElementChild).focus({preventScroll: true});
  }
  observeMenus(canvas, view) {
    if (this.menuObservers.has(canvas)) return;
    const root = view.containerEl;
    const selector = '.canvas-menu, .canvas-card-menu, .canvas-color-picker';
    const relevant = element => element?.nodeType === 1 &&
      (element.matches(selector + ', .canvas-color-picker-item') || element.querySelector(selector + ', .canvas-color-picker-item'));
    const observer = new root.ownerDocument.defaultView.MutationObserver(records => {
      if (!records.some(record => record.target.closest?.(selector) ||
          [...record.addedNodes, ...record.removedNodes].some(relevant))) return;
      // Mutation callbacks run before rendering; don't observe our own button additions.
      observer.disconnect();
      try {
        this.syncTransparentChoice(canvas, view);
        this.syncStyleButton(canvas, view);
      } finally { observer.observe(root, {childList: true, subtree: true}); }
    });
    observer.observe(root, {childList: true, subtree: true});
    this.menuObservers.set(canvas, observer);
  }
  syncTransparentChoice(canvas, view) {
    const palettes = new Set([...view.containerEl.querySelectorAll('.canvas-color-picker-item')].map(el => el.parentElement));
    for (const palette of palettes) {
      const selected = [...canvas.selection];
      const transparent = selected.length > 0 && selected.every(node => node.getData().color === 'transparent');
      const existing = palette.querySelector('.canvas-authoring-transparent-choice');
      if (existing) {
        existing.classList.toggle('is-active', transparent);
        if (transparent) palette.querySelectorAll('.canvas-color-picker-item:not(.canvas-authoring-transparent-choice)').forEach(el => el.classList.remove('is-active'));
        continue;
      }
      // Native picker treats the unsupported transparent value as a custom black.
      // The extension owns its swatch and selection state instead.
      if (transparent) palette.querySelectorAll('.canvas-color-picker-item').forEach(el => el.classList.remove('is-active'));
      const option = document.createElement('div');
      option.className = 'canvas-color-picker-item canvas-authoring-transparent-choice';
      option.classList.toggle('is-active', transparent);
      option.setAttribute('role', 'button'); option.tabIndex = 0;
      option.title = 'Transparent background and border'; option.setAttribute('aria-label', 'Transparent background and border');
      const apply = () => {
        if (canvas.readonly) return;
        for (const node of canvas.selection) {
          if (!canvas.nodes.has(node.id)) continue;
          node.setData({...node.getData(), color: 'transparent'});
          this.paintNode(node);
        }
        canvas.requestSave();
        palette.querySelectorAll('.canvas-color-picker-item').forEach(el => el.classList.remove('is-active'));
        option.classList.add('is-active');
      };
      option.addEventListener('click', event => { event.stopPropagation(); apply(); });
      option.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); apply(); }
      });
      palette.appendChild(option);
    }
  }
  syncStyleButton(canvas, view) {
    const controls = canvas.cardMenuEl || view.containerEl.querySelector('.canvas-card-menu');
    if (controls && !canvas.readonly && !controls.querySelector('.canvas-authoring-new-note')) {
      const add = document.createElement('div');
      add.setAttribute('role', 'button');
      add.tabIndex = 0;
      add.className = 'canvas-card-menu-button canvas-authoring-new-note';
      add.setAttribute('aria-label', 'Add annotation');
      if (typeof setTooltip === 'function') {
        setTooltip(add, 'Add annotation', {placement: 'top'});
      } else {
        add.setAttribute('data-tooltip-position', 'top');
      }
      setIcon(add, 'type');
      add.addEventListener('click', event => { event.stopPropagation(); this.addAnnotation(canvas); });
      add.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); this.addAnnotation(canvas);
        }
      });
      controls.appendChild(add);
    }
    const toolbar = view.containerEl.querySelector('.canvas-menu');
    if (!toolbar) return;
    const node = this.selected(canvas);
    if (this.fontPalette?.canvas === canvas &&
        (this.fontPalette.node !== node || !this.fontPalette.button.isConnected || canvas.readonly)) {
      this.fontPalette.close();
    }
    let button = toolbar.querySelector('.canvas-authoring-style');
    if (!node || node.getData().type !== 'text') { button?.remove(); toolbar.querySelector('.canvas-authoring-font-scale')?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.className = 'clickable-icon canvas-authoring-style';
      button.type = 'button';
      button.title = 'Text color';
      button.setAttribute('aria-label', 'Text color');
      button.setAttribute('aria-expanded', 'false');
      setIcon(button, 'type');
      button.addEventListener('pointerdown', e => e.stopPropagation());
      button.addEventListener('click', event => {
        event.stopPropagation();
        const current = this.selected(canvas);
        if (current?.getData().type === 'text' && !canvas.readonly) this.toggleFontPalette(canvas, current, button);
      });
      toolbar.appendChild(button);
    }
    let scaleButton = toolbar.querySelector('.canvas-authoring-font-scale');
    if (!scaleButton) {
      scaleButton = toolbar.ownerDocument.createElement('button');
      scaleButton.className = 'clickable-icon canvas-authoring-font-scale';
      scaleButton.type = 'button';
      scaleButton.title = 'Font scale';
      scaleButton.setAttribute('aria-label', 'Font scale');
      scaleButton.addEventListener('pointerdown', event => event.stopPropagation());
      scaleButton.addEventListener('click', event => {
        event.stopPropagation();
        const current = this.selected(canvas);
        if (current?.getData().type === 'text') this.fontScaleMenu(current, event);
      });
      toolbar.appendChild(scaleButton);
    }
    const label = `${node.getData().fontScale ?? 1}×`;
    if (scaleButton.textContent !== label) scaleButton.textContent = label;
  }
  // Reuse native hit testing, pan, cancellation and the empty-space creation menu.
  // Only this gesture's edge ends differ from the native flow connector.
  startConnection(event, canvas, node, direction, button) {
    if (canvas.readonly || !event.isPrimary || event.button !== 0) return;
    if (typeof node.onConnectionPointerdown !== 'function') {
      new Notice('This version of Obsidian does not support this connection action.'); return;
    }
    this.cancelConnectionStart?.();
    button.connectionDragged = false;
    const original = canvas.addEdge, plugin = this, win = button.ownerDocument.defaultView;
    const cleanup = () => {
      if (canvas.addEdge === wrapped) canvas.addEdge = original;
      win.removeEventListener('pointerup', release);
      win.removeEventListener('pointercancel', release);
      win.removeEventListener('blur', cleanup);
      win.removeEventListener('keydown', escape);
      if (plugin.cancelConnectionStart === cleanup) plugin.cancelConnectionStart = null;
    };
    const release = e => { if (e.pointerId === event.pointerId) cleanup(); };
    const escape = e => { if (e.key === 'Escape') cleanup(); };
    const wrapped = function(edge, ...args) {
      // Ignore unrelated additions while waiting for the native drag threshold.
      if (edge.from?.node !== node || edge.from?.side !== direction) return original.call(this, edge, ...args);
      cleanup();
      button.connectionDragged = true;
      const update = edge.update;
      const association = function(from, to) {
        const result = update.call(this, {...from, end: 'none'}, {...to, end: 'none'});
        plugin.draw(this);
        return result;
      };
      edge.update = association;
      plugin.connectionUpdates.set(edge, {original: update, wrapped: association});
      const result = original.call(this, edge, ...args);
      association.call(edge, edge.from, edge.to);
      plugin.draw(edge);
      return result;
    };
    canvas.addEdge = wrapped;
    this.cancelConnectionStart = cleanup;
    win.addEventListener('pointerup', release);
    win.addEventListener('pointercancel', release);
    win.addEventListener('blur', cleanup);
    win.addEventListener('keydown', escape);
    try { node.onConnectionPointerdown(event, direction); }
    catch (error) { cleanup(); throw error; }
  }
  releaseConnectionUpdates() {
    for (const [edge, record] of this.connectionUpdates) {
      const canvas = edge.canvas;
      if (canvas.edges.has(edge.id) && (canvas.isDragging || !canvas.nodes.has(edge.to.node.id))) continue;
      if (edge.update === record.wrapped) edge.update = record.original;
      this.connectionUpdates.delete(edge);
    }
  }
  syncControls(canvas) {
    const selected = this.selected(canvas);
    for (const [node, element] of this.controls) {
      if (!element.isConnected || (node.canvas === canvas && node !== selected)) {
        element.remove(); this.controls.delete(node);
      }
    }
    if (!selected || canvas.readonly || this.controls.has(selected) || !selected.nodeEl) return;
    const container = document.createElement('div');
    container.className = 'canvas-authoring-controls';
    const labels = {top: 'above', right: 'to the right', bottom: 'below', left: 'to the left'};
    for (const direction of Object.keys(labels)) {
      const button = document.createElement('button');
      button.className = `canvas-authoring-add canvas-authoring-${direction}`;
      button.textContent = '+';
      button.type = 'button';
      button.setAttribute('aria-label', `Add a child node ${labels[direction]}`);
      button.title = `Add a child node ${labels[direction]}. Drag to connect or create a node.`;
      button.addEventListener('pointerdown', event => {
        event.stopPropagation();
        this.startConnection(event, canvas, selected, direction, button);
      });
      // Canvas starts resize/drag on press; isolate both pointer and legacy mouse events.
      for (const type of ['mousedown', 'touchstart']) {
        button.addEventListener(type, event => {
          event.preventDefault();
          event.stopPropagation();
        }, {passive: false});
      }
      button.addEventListener('dblclick', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (button.connectionDragged) { button.connectionDragged = false; return; }
        this.add(canvas, selected, 'child', direction);
      });
      container.appendChild(button);
    }
    selected.nodeEl.appendChild(container);
    this.controls.set(selected, container);
  }
  draw(edge) {
    const data = edge.getData();
    if (!this.isConnection(data)) return;
    const edgePath = edge.path;
    if (!edgePath || !edge.from?.node || !edge.to?.node) return;
    // Path elements may be mounted in separate steps while pasted edges import.
    // Cache the path object once and skip whichever SVG element is not ready yet.
    // Use actual card edges, not the native Bezier's offset control endpoints.
    const endpoint = end => {
      const box = end.node.getBBox();
      const x = (box.minX + box.maxX) / 2, y = (box.minY + box.maxY) / 2;
      return {left:{x:box.minX,y}, right:{x:box.maxX,y}, top:{x,y:box.minY}, bottom:{x,y:box.maxY}}[end.side];
    };
    const a = endpoint(edge.from), b = endpoint(edge.to);
    if (!a || !b) return;
    const path = orthogonalCanvasPath(a, b, data.fromSide, data.toSide);
    for (const element of [edgePath.display, edgePath.interaction]) {
      if (element && element.getAttribute('d') !== path) element.setAttribute('d', path);
    }
  }
  updateThemeClass() {
    document.body.classList.toggle('canvas-authoring-claude-theme', this.settings.claudeCanvasTheme);
  }
  onunload() {
    this.fontPalette?.close();
    document.body.classList.remove('canvas-authoring-claude-theme');
    for (const [node, {original, wrapped}] of this.fontBreakpoints) {
      if (node.updateBreakpoint === wrapped) node.updateBreakpoint = original;
      node.nodeEl.classList.remove('canvas-authoring-scaled-text');
      node.nodeEl.style.removeProperty('--authoring-font-size');
      node.nodeEl.style.removeProperty('--font-text-size');
      node.nodeEl.style.removeProperty('font-size');
      if (!node.destroyed) node.render();
    }
    this.fontBreakpoints.clear();
    for (const observer of this.menuObservers.values()) observer.disconnect();
    this.menuObservers.clear();
    for (const observer of this.editorObservers.values()) observer.disconnect();
    this.editorObservers.clear();
    document.querySelectorAll('.canvas-authoring-editor-surface').forEach(el => el.classList.remove('canvas-authoring-editor-surface'));
    this.cancelConnectionStart?.();
    this.app.workspace.iterateAllLeaves(leaf => {
      for (const iframe of leaf.view?.containerEl?.querySelectorAll('iframe.embed-iframe.is-controlled') || []) {
        iframe.contentDocument?.getElementById('canvas-authoring-editor-surface')?.remove();
        iframe.classList.remove('canvas-authoring-surface-ready');
      }
    });
    for (const [edge, record] of this.connectionUpdates) {
      if (edge.update === record.wrapped) edge.update = record.original;
    }
    this.connectionUpdates.clear();
    for (const [canvas, {original, wrapped}] of this.creationMenus) {
      if (canvas.showCreationMenu === wrapped) canvas.showCreationMenu = original;
    }
    this.creationMenus.clear();
    for (const [canvas, {original, wrapped}] of this.pasteHandlers) {
      if (canvas.handlePaste === wrapped) canvas.handlePaste = original;
    }
    this.pasteHandlers.clear();
    document.querySelectorAll('.canvas-authoring-style, .canvas-authoring-new-note, .canvas-authoring-font-scale').forEach(el => el.remove());
    document.querySelectorAll('.canvas-authoring-transparent-choice, .canvas-authoring-empty-placeholder').forEach(el => el.remove());
    document.querySelectorAll('.canvas-authoring-empty-text').forEach(el => el.classList.remove('canvas-authoring-empty-text'));
    document.querySelectorAll('.canvas-authoring-transparent, .canvas-authoring-font-color').forEach(el => {
      el.classList.remove('canvas-authoring-transparent', 'canvas-authoring-font-color');
      el.style.removeProperty('--authoring-font-color');
    });
    for (const element of this.controls.values()) element.remove();
    this.controls.clear();
    for (const [edge, {original, wrapped}] of this.patched) {
      if (edge.updatePath === wrapped) edge.updatePath = original;
      if (edge.path?.interaction && edge.path?.display) edge.updatePath();
    }
    this.patched.clear();
  }
};

class CanvasAuthoringSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Claude Canvas theme')
      .setDesc('Use a light canvas, pastel cards, and subtle connectors.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.claudeCanvasTheme)
        .onChange(async value => {
          this.plugin.settings.claudeCanvasTheme = value;
          this.plugin.updateThemeClass();
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}

// Parse a small flowchart subset into the same data format as Canvas JSON paste.
function mermaidToCanvas(source) {
  let body = source;
  const header = body.match(/^(?:flowchart|graph)[ \t]+(TB|TD|BT|LR|RL)(?:[ \t]*(?:\r?\n|;|$))/);
  if (!header) throw new Error('Expected mindmap or a flowchart with direction TD, TB, BT, LR, or RL. Only flowcharts and mind maps can be imported.');
  const direction = header[1];
  body = body.slice(header[0].length);
  const nodes = new Map();
  const edges = [];
  // Consume complete node and edge labels before looking for statement separators.
  const nodePattern = /([\p{L}\p{N}_][\p{L}\p{N}_-]*?)(?=-->|---|<-->|==>|-\.->|[\s;[({]|$)(?:(?:\[\[("[^"]*"|[^\]\n]+)\]\]|\[("[^"]*"|[^\]\n]+)\]|\(\(("[^"]*"|[^)\n]+)\)\)|\(("[^"]*"|[^)\n]+)\)|\{("[^"]*"|[^}\n]+)\}))?/uy;
  const connector = /(<-->|-->|---|==>|-\.->)(?:[ \t]*\|([^|\r\n]*)\|)?/y;
  let cursor = 0;
  const skipSpaces = () => {
    while (/[ \t\r]/.test(body[cursor] || '')) cursor++;
  };
  const fail = () => {
    const line = body.slice(0, cursor).split('\n').length + 1;
    throw new Error(`Unsupported Mermaid syntax near line ${line} of the diagram. Use simple flowchart nodes and links.`);
  };
  const clean = text => text.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, '\n');
  const readNode = () => {
    nodePattern.lastIndex = cursor;
    const match = nodePattern.exec(body);
    if (!match) fail();
    cursor = nodePattern.lastIndex;
    const [, id, ...labels] = match;
    const label = labels.find(value => value !== undefined);
    if (label !== undefined || !nodes.has(id)) nodes.set(id, label === undefined ? id : clean(label));
    return id;
  };
  while (cursor < body.length) {
    skipSpaces();
    if (cursor === body.length) break;
    if (body.startsWith('%%', cursor)) {
      const end = body.indexOf('\n', cursor);
      cursor = end < 0 ? body.length : end;
    }
    if (body[cursor] === ';' || body[cursor] === '\n') { cursor++; continue; }
    if (cursor === body.length) break;

    let fromNode = readNode();
    while (cursor < body.length) {
      skipSpaces();
      if (cursor === body.length || body[cursor] === ';' || body[cursor] === '\n' || body.startsWith('%%', cursor)) break;
      connector.lastIndex = cursor;
      const link = connector.exec(body);
      if (!link) fail();
      cursor = connector.lastIndex;
      skipSpaces();
      const toNode = readNode();
      const [, arrow, label] = link;
      edges.push({
        id: String(edges.length), fromNode, toNode,
        fromEnd: arrow === '<-->' ? 'arrow' : 'none',
        toEnd: arrow === '---' ? 'none' : 'arrow',
        ...(label === undefined ? {} : {label: clean(label)})
      });
      fromNode = toNode;
    }
  }
  if (!nodes.size) throw new Error('The flowchart contains no cards.');

  const outgoing = new Map([...nodes.keys()].map(id => [id, []]));
  const incoming = new Set();
  for (const edge of edges) {
    outgoing.get(edge.fromNode).push(edge.toNode);
    incoming.add(edge.toNode);
  }

  // Ignore back edges for ranking only. Keep them in the imported diagram.
  const levels = new Map([...nodes.keys()].map(id => [id, 0]));
  const forwardEdges = new Map([...nodes.keys()].map(id => [id, []]));
  const state = new Map();
  const order = [];
  const visit = root => {
    if (state.has(root)) return;
    const stack = [{id: root, next: 0}];
    state.set(root, 'visiting');
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id);
      if (frame.next === children.length) {
        state.set(frame.id, 'finished');
        order.push(frame.id);
        stack.pop();
        continue;
      }
      const child = children[frame.next++];
      if (state.get(child) === 'visiting') continue;
      forwardEdges.get(frame.id).push(child);
      if (!state.has(child)) {
        state.set(child, 'visiting');
        stack.push({id: child, next: 0});
      }
    }
  };
  for (const id of nodes.keys()) if (!incoming.has(id)) visit(id);
  for (const id of nodes.keys()) visit(id);
  for (const id of order.reverse()) {
    for (const child of forwardEdges.get(id)) {
      levels.set(child, Math.max(levels.get(child), levels.get(id) + 1));
    }
  }

  const horizontal = direction === 'LR' || direction === 'RL';
  const reversed = direction === 'RL' || direction === 'BT';
  const layers = [];
  const neighbors = new Map([...nodes.keys()].map(id => [id, new Set()]));
  for (const edge of edges) {
    neighbors.get(edge.fromNode).add(edge.toNode);
    neighbors.get(edge.toNode).add(edge.fromNode);
  }
  for (const [id, level] of levels) (layers[level] ??= []).push(id);

  // Sweep in both directions so cards tend to line up with their connected neighbors.
  const slots = new Map();
  const assignSlots = layer => layer.forEach((id, i) => slots.set(id, i - (layer.length - 1) / 2));
  layers.forEach(assignSlots);
  for (const step of [1, -1, 1, -1]) {
    for (let level = step > 0 ? 0 : layers.length - 1; level >= 0 && level < layers.length; level += step) {
      const layer = layers[level];
      const scores = new Map(layer.map(id => {
        const adjacent = [...neighbors.get(id)].filter(other => (level - levels.get(other)) * step > 0);
        return [id, adjacent.length ? adjacent.reduce((sum, other) => sum + slots.get(other), 0) / adjacent.length : slots.get(id)];
      }));
      layer.sort((a, b) => scores.get(a) - scores.get(b));
      assignSlots(layer);
    }
  }

  const cards = [];
  const byId = new Map();
  const estimateWidth = text => [...text].reduce((width, char) => width + (/[^\x00-\xff]/.test(char) ? 16 : 9), 0);
  const labelSpace = edges.reduce((max, edge) => Math.max(max, estimateWidth(edge.label || '')), 0);
  const crossGap = 84 + Math.min(140, labelSpace);
  const rankGap = 112 + Math.min(160, labelSpace);
  let primary = 0;
  for (const layer of layers) {
    const row = layer.map(id => {
      const text = nodes.get(id);
      const lines = text.split('\n');
      const longest = Math.max(...lines.map(estimateWidth));
      const width = Math.max(140, Math.min(300, longest + 44));
      const rows = lines.reduce((count, line) => count + Math.max(1, Math.ceil(estimateWidth(line) / (width - 40))), 0);
      return {id, text, type: 'text', width, height: Math.max(56, rows * 22 + 32)};
    });
    const primarySize = Math.max(...row.map(card => horizontal ? card.width : card.height));
    const crossSize = row.reduce((size, card) => size + (horizontal ? card.height : card.width), 0) + crossGap * (row.length - 1);
    let cross = -crossSize / 2;
    for (const card of row) {
      const extent = horizontal ? card.width : card.height;
      const along = primary + (primarySize - extent) / 2;
      const offset = reversed ? -along - extent : along;
      card.x = horizontal ? offset : cross;
      card.y = horizontal ? cross : offset;
      cross += (horizontal ? card.height : card.width) + crossGap;
      cards.push(card);
      byId.set(card.id, card);
    }
    primary += primarySize + rankGap;
  }

  for (const edge of edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
    const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
    const sameLayer = levels.get(from.id) === levels.get(to.id);
    if (from === to) {
      [edge.fromSide, edge.toSide] = ['right', 'bottom'];
    } else if (horizontal !== sameLayer) {
      [edge.fromSide, edge.toSide] = dx >= 0 ? ['right', 'left'] : ['left', 'right'];
    } else {
      [edge.fromSide, edge.toSide] = dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
    }
  }
  return {nodes: cards, edges};
}

function unwrapMermaid(source) {
  const text = source.trim();
  const opening = text.match(/^(`{3,}|~{3,})[ \t]*(?:mermaid)?[ \t]*\r?\n/i);
  let body = text;
  if (opening) {
    const close = new RegExp(`\\r?\\n[ \\t]*${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
    if (!close.test(text)) throw new Error('The Mermaid code block is missing its closing fence.');
    body = text.slice(opening[0].length).replace(close, '');
  } else if (/^(`{3,}|~{3,})/.test(text)) {
    throw new Error('Use a Mermaid code block or paste the diagram source directly.');
  } else {
    body = body.replace(/^mermaid[ \t]*\r?\n/i, '');
  }
  return body.trim();
}

function mindMapToCanvas(body) {
  const lines = body.split(/\r?\n/);
  if (!/^mindmap[ \t]*$/.test(lines[0])) throw new Error('Put mindmap on its own line.');
  const nodes = [];
  const edges = [];
  const stack = [];
  const depths = [];
  let y = 0;
  const shape = /^[\p{L}\p{N}_-]+\s*(\(\(|\)\)|\{\{|\[|\(|\))/u;
  const endings = {'((': '))', '))': '((', '{{': '}}', '[': ']', '(': ')', ')': '('};
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    let text = line.trim();
    if (!text || text.startsWith('%%')) continue;
    if (/^(?:::icon|:::)/.test(text)) throw new Error(`Icons and classes are not supported on line ${index + 1}.`);
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    const match = text.match(shape);
    if (match) {
      const end = endings[match[1]];
      if (!text.endsWith(end)) throw new Error(`Unclosed mind map node shape on line ${index + 1}.`);
      text = text.slice(match[0].length, -end.length).trim().replace(/^"(.*)"$/, '$1');
    }
    if (!text) throw new Error(`Missing node text on line ${index + 1}.`);
    text = text.replace(/<br\s*\/?>/gi, '\n');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (nodes.length && !stack.length) throw new Error(`Line ${index + 1} must be indented under the root node.`);
    const id = String(nodes.length);
    const depth = stack.length;
    const labelLines = text.split('\n');
    const textWidths = labelLines.map(line => [...line].reduce((width, char) =>
      width + (/[^\x00-\xff]/.test(char) ? 16 : 9), 0));
    const width = Math.max(120, Math.min(280, Math.max(...textWidths) + 40));
    const rows = textWidths.reduce((count, length) => count + Math.max(1, Math.ceil(length / (width - 32))), 0);
    const height = Math.max(52, rows * 20 + 28);
    if (depth === 1 && depths[1]) y += 16;
    const node = {id, text, type: 'text', x: 0, y, width, height};
    (depths[depth] ??= []).push(node);
    nodes.push(node);
    y += height + 20;
    if (depth) edges.push({
      id, fromNode: stack[depth - 1].id, toNode: id,
      fromSide: 'bottom', toSide: 'left', fromEnd: 'none', toEnd: 'none'
    });
    stack.push({id, indent});
  }
  if (!nodes.length) throw new Error('Add a root node below mindmap.');
  let x = 0;
  for (const layer of depths) {
    for (const node of layer) node.x = x;
    x += Math.max(...layer.map(node => node.width)) / 2 + 32;
  }
  return {nodes, edges};
}

function orthogonalCanvasPath(a, b, fromSide, toSide) {
  const vertical = side => side === 'top' || side === 'bottom';
  if (fromSide === 'bottom' && toSide === 'left' && b.x > a.x && b.y > a.y) {
    return `M ${a.x} ${a.y} L ${a.x} ${b.y} L ${b.x} ${b.y}`;
  }
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  return vertical(fromSide)
    ? `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`
    : `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`;
}

function renderCanvasImportPreview(container, data) {
  const doc = container.ownerDocument;
  const svgNode = (tag, attrs, parent) => {
    const element = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    parent.appendChild(element);
    return element;
  };
  const minX = Math.min(...data.nodes.map(node => node.x)) - 24;
  const minY = Math.min(...data.nodes.map(node => node.y)) - 24;
  const width = Math.max(...data.nodes.map(node => node.x + node.width)) - minX + 24;
  const height = Math.max(...data.nodes.map(node => node.y + node.height)) - minY + 24;
  const svg = svgNode('svg', {viewBox: `${minX} ${minY} ${width} ${height}`, width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Canvas import layout'}, container);
  const markerId = `canvas-preview-arrow-${crypto.randomUUID()}`;
  const marker = svgNode('marker', {id: markerId, markerWidth: 7, markerHeight: 7, refX: 7, refY: 3.5, orient: 'auto-start-reverse'}, svgNode('defs', {}, svg));
  svgNode('path', {d: 'M 0 0 L 7 3.5 L 0 7 z', fill: 'var(--text-muted)'}, marker);
  const byId = new Map(data.nodes.map(node => [node.id, node]));
  const vectors = {top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0]};
  const anchor = (node, side) => {
    const [dx, dy] = vectors[side];
    return {x: node.x + node.width * (1 + dx) / 2, y: node.y + node.height * (1 + dy) / 2};
  };
  for (const edge of data.edges) {
    const a = anchor(byId.get(edge.fromNode), edge.fromSide);
    const b = anchor(byId.get(edge.toNode), edge.toSide);
    const [ax, ay] = vectors[edge.fromSide];
    const [bx, by] = vectors[edge.toSide];
    const reach = Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) / 2);
    const directed = edge.fromEnd === 'arrow' || edge.toEnd === 'arrow';
    const d = directed
      ? `M ${a.x} ${a.y} C ${a.x + ax * reach} ${a.y + ay * reach} ${b.x + bx * reach} ${b.y + by * reach} ${b.x} ${b.y}`
      : orthogonalCanvasPath(a, b, edge.fromSide, edge.toSide);
    const path = svgNode('path', {d, fill: 'none', stroke: 'var(--text-muted)', 'stroke-width': 2}, svg);
    if (edge.fromEnd === 'arrow') path.setAttribute('marker-start', `url(#${markerId})`);
    if (edge.toEnd === 'arrow') path.setAttribute('marker-end', `url(#${markerId})`);
    if (edge.label) {
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      svgNode('text', {x: point.x, y: point.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 14, fill: 'var(--text-normal)', stroke: 'var(--background-primary)',
        'stroke-width': 5, 'paint-order': 'stroke'}, svg).textContent = edge.label;
    }
  }
  for (const {x, y, width, height, text} of data.nodes) {
    svgNode('rect', {x, y, width, height, rx: 4, fill: 'var(--background-primary)', stroke: 'var(--background-modifier-border)'}, svg);
    const frame = svgNode('foreignObject', {x, y, width, height}, svg);
    const label = doc.createElement('div');
    label.className = 'canvas-authoring-mermaid-preview-card';
    label.textContent = text;
    frame.appendChild(label);
  }
}

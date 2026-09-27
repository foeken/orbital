// src/model/tree.ts
var UNIT = { x: 0, y: 0, w: 1, h: 1 };
function edgeAxis(edge) {
  return edge === "left" || edge === "right" ? "x" : "y";
}
function edgeBefore(edge) {
  return edge === "left" || edge === "top";
}
function layoutRects(node, rect = UNIT, parent = null, out = /* @__PURE__ */ new Map()) {
  if (!node) return out;
  out.set(node.id, { node, rect, parent });
  if (node.kind === "stage") {
    if (node.child) layoutRects(node.child, rect, node.id, out);
  } else if (node.kind === "split") {
    const total = sum(node.weights);
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.weights[i] / total;
      const r = node.axis === "x" ? { ...rect, x: rect.x + offset * rect.w, w: rect.w * share } : { ...rect, y: rect.y + offset * rect.h, h: rect.h * share };
      layoutRects(child, r, node.id, out);
      offset += share;
    });
  }
  return out;
}
function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}
function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.kind === "stage") return findNode(node.child, id);
  if (node.kind === "split")
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  return null;
}
function panelsOf(node) {
  if (!node) return [];
  if (node.kind === "panel") return [node];
  if (node.kind === "stage") return panelsOf(node.child);
  return node.children.flatMap(panelsOf);
}
function findStage(node) {
  if (!node) return null;
  if (node.kind === "stage") return node;
  if (node.kind === "split")
    for (const child of node.children) {
      const stage = findStage(child);
      if (stage) return stage;
    }
  return null;
}
function normalize(node) {
  if (node.kind === "panel") return node.views.length ? node : null;
  if (node.kind === "stage") {
    const child = node.child ? normalize(node.child) : null;
    if ((child ?? void 0) === node.child) return node;
    return {
      ...node,
      child: child ?? void 0
    };
  }
  const children = [];
  const weights = [];
  node.children.forEach((child, i) => {
    const next = normalize(child);
    const raw = node.weights[i];
    const weight = Number.isFinite(raw) && raw > 0 ? raw : 1e-3;
    if (!next) return;
    if (next.kind === "split" && next.axis === node.axis) {
      const total2 = sum(next.weights);
      next.children.forEach((grandchild, j) => {
        children.push(grandchild);
        weights.push(weight * next.weights[j] / total2);
      });
    } else {
      children.push(next);
      weights.push(weight);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sum(weights);
  const normalized = weights.map((w) => w / total);
  if (children.length === node.children.length && children.every(
    (child, i) => child === node.children[i] && Math.abs(normalized[i] - node.weights[i]) < 1e-12
  ))
    return node;
  return { ...node, children, weights: normalized };
}
function removeNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root.kind === "stage" ? root : null;
  if (root.kind === "panel") return root;
  if (root.kind === "stage") {
    if (!root.child) return root;
    if (root.child.id === id) return { ...root, child: void 0 };
    const child = removeNode(root.child, id);
    return child === root.child ? root : { ...root, child: child ?? void 0 };
  }
  const index = root.children.findIndex((child) => child.id === id);
  if (index >= 0) {
    if (root.children[index].kind === "stage") return root;
    const children2 = [...root.children];
    const weights2 = [...root.weights];
    const removed = weights2[index];
    children2.splice(index, 1);
    weights2.splice(index, 1);
    if (!children2.length) return null;
    weights2[Math.min(index, weights2.length - 1)] += removed;
    return normalize({ ...root, children: children2, weights: weights2 });
  }
  let changed = false;
  const children = [];
  const weights = [];
  root.children.forEach((child, i) => {
    const next = removeNode(child, id);
    if (next !== child) changed = true;
    if (next) {
      children.push(next);
      weights.push(root.weights[i]);
    } else if (weights.length) weights[weights.length - 1] += root.weights[i];
  });
  if (!changed) return root;
  if (!children.length) return null;
  return normalize({ ...root, children, weights });
}
function insertBeside(root, targetId, incoming, edge, splitId, share = 0.5) {
  if (!root) return incoming;
  share = Math.min(0.9, Math.max(0.1, share));
  const wrap = (target) => {
    const before = edgeBefore(edge);
    return normalize({
      kind: "split",
      id: splitId,
      axis: edgeAxis(edge),
      weights: before ? [share, 1 - share] : [1 - share, share],
      children: before ? [incoming, target] : [target, incoming]
    });
  };
  if (root.id === targetId) return wrap(root);
  if (root.kind === "panel") return root;
  if (root.kind === "stage") {
    if (!root.child) return root;
    const child = insertBeside(root.child, targetId, incoming, edge, splitId, share);
    return child === root.child ? root : { ...root, child };
  }
  let changed = false;
  const children = root.children.map((child) => {
    const next = insertBeside(child, targetId, incoming, edge, splitId, share);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? normalize({ ...root, children }) : root;
}
function replaceNode(root, id, replacement) {
  if (!root) return root;
  if (root.id === id) return replacement;
  if (root.kind === "panel") return root;
  if (root.kind === "stage") {
    if (!root.child) return root;
    const child = replaceNode(root.child, id, replacement);
    return child === root.child ? root : { ...root, child };
  }
  let changed = false;
  const children = root.children.map((child) => {
    const next = replaceNode(child, id, replacement);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}
function resizeBoundary(split, index, position, min = () => 0.04) {
  const weights = [...split.weights];
  const total = sum(weights);
  const normalized = weights.map((w) => w / total);
  const start = sum(normalized.slice(0, index));
  const pair = normalized[index] + normalized[index + 1];
  const lo = Math.min(min(index), pair / 2);
  const hi = pair - Math.min(min(index + 1), pair / 2);
  const left = Math.max(lo, Math.min(hi, position - start));
  normalized[index] = left;
  normalized[index + 1] = pair - left;
  return { ...split, weights: normalized };
}

// src/model/document.ts
var counter = 0;
function uid(prefix) {
  counter = (counter + 1) % 1e6;
  const random = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${random}${counter.toString(36)}`;
}
function emptyDocument() {
  return { schema: 1, root: null, floating: [], hidden: [], views: {} };
}
function allPanels(doc) {
  return [...panelsOf(doc.root), ...doc.floating.map((f) => f.panel), ...doc.hidden.map((h2) => h2.panel)];
}
function locatePanel(doc, panelId) {
  const docked = findNode(doc.root, panelId);
  if (docked?.kind === "panel") return { where: "docked", panel: docked };
  const float = doc.floating.find((f) => f.panel.id === panelId);
  if (float) return { where: "floating", panel: float.panel, float };
  const hidden = doc.hidden.find((h2) => h2.panel.id === panelId);
  if (hidden) return { where: "hidden", panel: hidden.panel, restore: hidden.restore };
  return null;
}
function panelOfView(doc, viewId) {
  return allPanels(doc).find((p) => p.views.includes(viewId)) ?? null;
}
function updatePanel(doc, panel) {
  if (!panel.views.length) return removePanel(doc, panel.id);
  if (!panel.views.includes(panel.selected)) panel = { ...panel, selected: panel.views[0] };
  const location = locatePanel(doc, panel.id);
  if (!location) return doc;
  if (location.where === "docked") return { ...doc, root: replaceNode(doc.root, panel.id, panel) };
  if (location.where === "floating")
    return {
      ...doc,
      floating: doc.floating.map((f) => f.panel.id === panel.id ? { ...f, panel } : f)
    };
  return {
    ...doc,
    hidden: doc.hidden.map((h2) => h2.panel.id === panel.id ? { ...h2, panel } : h2)
  };
}
function removePanel(doc, panelId) {
  const location = locatePanel(doc, panelId);
  if (!location) return doc;
  if (location.where === "docked") return { ...doc, root: removeNode(doc.root, panelId) };
  if (location.where === "floating")
    return {
      ...doc,
      floating: doc.floating.filter((f) => f.panel.id !== panelId)
    };
  return { ...doc, hidden: doc.hidden.filter((h2) => h2.panel.id !== panelId) };
}
function detachView(doc, viewId) {
  const panel = panelOfView(doc, viewId);
  if (!panel) return doc;
  const views = panel.views.filter((id) => id !== viewId);
  let selected = panel.selected;
  if (selected === viewId) {
    const index = panel.views.indexOf(viewId);
    selected = views[Math.min(index, views.length - 1)] ?? "";
  }
  return updatePanel(doc, { ...panel, views, selected });
}
function closeView(doc, viewId) {
  const next = detachView(doc, viewId);
  const views = { ...next.views };
  delete views[viewId];
  return { ...next, views };
}
function selectView(doc, viewId) {
  const panel = panelOfView(doc, viewId);
  if (!panel || panel.selected === viewId) return doc;
  return updatePanel(doc, { ...panel, selected: viewId });
}
function reorderTabs(doc, panelId, order) {
  const location = locatePanel(doc, panelId);
  if (!location) return doc;
  const views = location.panel.views;
  if (order.length !== views.length || order.some((id) => !views.includes(id))) return doc;
  return updatePanel(doc, { ...location.panel, views: order });
}
function insertPanel(doc, panel, target) {
  if ("into" in target) {
    const node = findNode(doc.root, target.into);
    if (node?.kind === "stage") {
      if (!node.child)
        return {
          ...doc,
          root: replaceNode(doc.root, node.id, { ...node, child: panel })
        };
      const first = panelsOf(node.child)[0];
      return mergeInto(doc, panel, first.id, target.index);
    }
    return mergeInto(doc, panel, target.into, target.index);
  }
  if (!doc.root) return { ...doc, root: panel };
  if (!findNode(doc.root, target.beside))
    return insertPanel(doc, panel, { beside: doc.root.id, edge: target.edge });
  return {
    ...doc,
    root: insertBeside(doc.root, target.beside, panel, target.edge, uid("split"), target.share)
  };
}
function mergeInto(doc, panel, intoId, index) {
  const location = locatePanel(doc, intoId);
  if (!location) return doc;
  const views = [...location.panel.views];
  views.splice(index ?? views.length, 0, ...panel.views);
  return updatePanel(doc, {
    ...location.panel,
    views,
    selected: panel.selected
  });
}
function floatPanel(doc, panel, rect, layer) {
  const z = Math.max(0, ...doc.floating.map((f) => f.z)) + 1;
  return {
    ...removePanel(doc, panel.id),
    floating: [...removePanel(doc, panel.id).floating, { panel, rect: clampFloat(rect), z, layer }]
  };
}
function clampFloat(rect) {
  const w = Math.min(1, Math.max(0.02, rect.w));
  const h2 = Math.min(1, Math.max(0.02, rect.h));
  return {
    w,
    h: h2,
    x: Math.min(1 - Math.min(w, 0.05), Math.max(-w + 0.05, rect.x)),
    y: Math.min(1 - Math.min(h2, 0.05), Math.max(0, rect.y))
  };
}
function raiseFloat(doc, panelId) {
  const top = Math.max(0, ...doc.floating.map((f) => f.z));
  const float = doc.floating.find((f) => f.panel.id === panelId);
  if (!float || float.z === top) return doc;
  return {
    ...doc,
    floating: doc.floating.map((f) => f.panel.id === panelId ? { ...f, z: top + 1 } : f)
  };
}
function restoreTargetFor(doc, panelId) {
  const location = locatePanel(doc, panelId);
  if (!location) return null;
  if (location.where === "floating")
    return {
      kind: "floating",
      rect: location.float.rect,
      layer: location.float.layer
    };
  if (location.where === "hidden") return location.restore;
  const parent = parentSplit(doc.root, panelId);
  if (!parent) {
    const stage = findStage(doc.root);
    if (stage && stage.child?.id === panelId) return { kind: "tab", panel: stage.id };
    return { kind: "docked", beside: doc.root?.id ?? "", edge: "left", share: 0.5 };
  }
  const index = parent.children.findIndex((c) => c.id === panelId);
  const after = !!parent.children[index + 1];
  const neighbourIndex = after ? index + 1 : index - 1;
  const neighbour = parent.children[neighbourIndex];
  const own = parent.weights[index];
  const share = own / (own + parent.weights[neighbourIndex]);
  const edge = parent.axis === "x" ? after ? "left" : "right" : after ? "top" : "bottom";
  return { kind: "docked", beside: neighbour.id, edge, share };
}
function parentSplit(root, id) {
  if (!root || root.kind === "panel") return null;
  if (root.kind === "stage") return parentSplit(root.child ?? null, id);
  if (root.children.some((c) => c.id === id)) return root;
  for (const child of root.children) {
    const found = parentSplit(child, id);
    if (found) return found;
  }
  return null;
}
function hidePanel(doc, panelId) {
  const location = locatePanel(doc, panelId);
  if (!location || location.where === "hidden") return doc;
  const restore = restoreTargetFor(doc, panelId);
  const removed = removePanel(doc, panelId);
  return {
    ...removed,
    hidden: [...removed.hidden, { panel: location.panel, restore }]
  };
}
function restorePanel(doc, panelId, fallbackLayer) {
  const hidden = doc.hidden.find((h2) => h2.panel.id === panelId);
  if (!hidden) return doc;
  const without = {
    ...doc,
    hidden: doc.hidden.filter((h2) => h2.panel.id !== panelId)
  };
  const { restore, panel } = hidden;
  if (restore.kind === "floating") return floatPanel(without, panel, restore.rect, restore.layer);
  if (restore.kind === "tab") {
    const target = locatePanel(without, restore.panel);
    const node = findNode(without.root, restore.panel);
    if (target && target.where !== "hidden" || node?.kind === "stage")
      return insertPanel(without, panel, { into: restore.panel });
  }
  if (restore.kind === "docked" && findNode(without.root, restore.beside))
    return insertPanel(without, panel, {
      beside: restore.beside,
      edge: restore.edge,
      share: restore.share
    });
  if (without.root) return floatPanel(without, panel, { x: 0.25, y: 0.2, w: 0.5, h: 0.6 }, fallbackLayer);
  return { ...without, root: panel };
}
function sanitize(input, isKnownType = () => true) {
  const doc = {
    schema: 1,
    version: input.version,
    root: input.root ?? null,
    floating: Array.isArray(input.floating) ? input.floating : [],
    hidden: Array.isArray(input.hidden) ? input.hidden : [],
    views: { ...input.views ?? {} },
    navigation: input.navigation
  };
  const seen = /* @__PURE__ */ new Set();
  const seenPanels = /* @__PURE__ */ new Set();
  const keep = (id) => {
    const record = doc.views[id];
    if (!record || typeof record.type !== "string" || seen.has(id)) return false;
    if (!isKnownType(record.type)) return false;
    seen.add(id);
    return true;
  };
  const fixPanel = (panel) => {
    if (!panel || panel.kind !== "panel" || seenPanels.has(panel.id)) return null;
    seenPanels.add(panel.id);
    const views = (panel.views ?? []).filter(keep);
    if (!views.length) return null;
    return {
      ...panel,
      views,
      selected: views.includes(panel.selected) ? panel.selected : views[0]
    };
  };
  let stages = 0;
  const fixNode = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.kind === "panel") return fixPanel(node);
    if (node.kind === "stage") {
      if (stages++) return node.child ? fixNode(node.child) : null;
      const child = node.child ? fixNode(node.child) : null;
      return {
        kind: "stage",
        id: node.id,
        child: child?.kind === "stage" ? void 0 : child ?? void 0
      };
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      const children = [];
      const weights = [];
      node.children.forEach((c, i) => {
        const fixed = fixNode(c);
        if (fixed) {
          children.push(fixed);
          const w = node.weights?.[i];
          weights.push(Number.isFinite(w) && w > 0 ? w : 1);
        }
      });
      if (!children.length) return null;
      return normalize({
        kind: "split",
        id: node.id,
        axis: node.axis === "y" ? "y" : "x",
        weights,
        children
      });
    }
    return null;
  };
  doc.root = doc.root ? fixNode(doc.root) : null;
  doc.root = doc.root ? normalize(doc.root) : null;
  doc.floating = doc.floating.map((f) => {
    const panel = f && fixPanel(f.panel);
    return panel ? {
      panel,
      rect: clampFloat(f.rect ?? { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }),
      z: Number.isFinite(f.z) ? f.z : 1,
      layer: f.layer === "stage" ? "stage" : "overlay"
    } : null;
  }).filter((f) => !!f);
  doc.hidden = doc.hidden.map((h2) => {
    const panel = h2 && fixPanel(h2.panel);
    return panel ? {
      panel,
      restore: h2.restore ?? {
        kind: "floating",
        rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 },
        layer: "overlay"
      }
    } : null;
  }).filter((h2) => !!h2);
  for (const id of Object.keys(doc.views)) if (!seen.has(id)) delete doc.views[id];
  return doc;
}
function viewIds(doc) {
  return allPanels(doc).flatMap((p) => p.views);
}

// src/model/builder.ts
var layout = {
  view(type, options = {}) {
    return { kind: "view", type, ...options };
  },
  panel(...args) {
    const [first, ...rest] = args;
    if (first && first.kind !== "view") {
      const options = first;
      return { kind: "panel", views: rest, ...options };
    }
    return { kind: "panel", views: args };
  },
  split(axis, children, options = {}) {
    return { kind: "split", axis, children, ...options };
  },
  row(children, weights) {
    return { kind: "split", axis: "x", children, weights };
  },
  column(children, weights) {
    return { kind: "split", axis: "y", children, weights };
  },
  stage(child, options = {}) {
    return { kind: "stage", child, ...options };
  }
};
function createDocument(root, options = {}) {
  const views = {};
  const explicit = /* @__PURE__ */ new Set();
  const collect = (spec) => {
    if (!spec) return;
    if (spec.kind === "view") spec.id && explicit.add(spec.id);
    else if (spec.kind === "panel") spec.views.forEach(collect);
    else if (spec.kind === "split") spec.children.forEach(collect);
    else collect(spec.child);
  };
  collect(root ?? void 0);
  for (const f of options.floating ?? []) collect(f.panel);
  const counters = /* @__PURE__ */ new Map();
  const nextId = (type) => {
    let id;
    do {
      const n = (counters.get(type) ?? 0) + 1;
      counters.set(type, n);
      id = `${type}-${n}`;
    } while (explicit.has(id) || views[id]);
    return id;
  };
  const addView = (spec) => {
    const id = spec.id ?? nextId(spec.type);
    if (views[id]) throw Error(`Trellis: duplicate view id "${id}"`);
    views[id] = {
      type: spec.type,
      ...spec.params ? { params: spec.params } : {},
      ...spec.title ? { title: spec.title } : {}
    };
    return id;
  };
  const panel = (spec) => {
    const specs = spec.kind === "view" ? [spec] : spec.views;
    const ids = specs.map(addView);
    const index = spec.kind === "panel" ? spec.selected ?? 0 : 0;
    return {
      kind: "panel",
      id: spec.kind === "panel" && spec.id || uid("panel"),
      views: ids,
      selected: ids[Math.min(index, ids.length - 1)] ?? ""
    };
  };
  let stages = 0;
  const build = (spec) => {
    switch (spec.kind) {
      case "view":
      case "panel":
        return panel(spec);
      case "stage": {
        if (stages++) throw Error("Trellis: a layout may contain one stage");
        const child = spec.child ? build(spec.child) : void 0;
        if (child?.kind === "stage") throw Error("Trellis: a stage cannot contain a stage");
        return { kind: "stage", id: spec.id ?? "stage", child };
      }
      case "split": {
        const children = spec.children.map(build);
        const weights = spec.weights && spec.weights.length === children.length ? spec.weights : children.map(() => 1);
        return {
          kind: "split",
          id: spec.id ?? uid("split"),
          axis: spec.axis,
          weights,
          children
        };
      }
    }
  };
  const tree = root ? normalize(build(root)) : null;
  return {
    schema: 1,
    ...options.version !== void 0 ? { version: options.version } : {},
    root: tree,
    floating: (options.floating ?? []).map((f, i) => ({
      panel: panel(f.panel),
      rect: f.rect,
      z: i + 1,
      layer: f.layer ?? "overlay"
    })),
    hidden: [],
    views
  };
}

// src/model/spatial.ts
function leafIds(node) {
  if (!node) return [];
  if (node.kind === "panel") return [node.id];
  if (node.kind === "stage") return node.child ? leafIds(node.child) : [node.id];
  return node.children.flatMap(leafIds);
}
function focusLayout(root) {
  const entries = layoutRects(root);
  for (const { node } of [...entries.values()]) {
    if (node.kind !== "split" || node.children.length < 3) continue;
    for (let start = 0; start < node.children.length - 1; start++) {
      for (let end = start + 2; end <= node.children.length; end++) {
        if (start === 0 && end === node.children.length) continue;
        const children = node.children.slice(start, end);
        const first = entries.get(children[0].id).rect;
        const last = entries.get(children[children.length - 1].id).rect;
        const id = rangeId(
          node.id,
          children.map((c) => c.id)
        );
        const weights = node.weights.slice(start, end);
        const total = sum(weights);
        entries.set(id, {
          node: { kind: "split", id, axis: node.axis, children, weights: weights.map((w) => w / total) },
          rect: { x: first.x, y: first.y, w: last.x + last.w - first.x, h: last.y + last.h - first.y },
          parent: node.id,
          virtual: true
        });
      }
    }
  }
  return entries;
}
var rangeId = (splitId, children) => `range:${JSON.stringify([splitId, ...children])}`;
function navParent(entries, id) {
  const entry = entries.get(id);
  let at = entry?.parent ?? null;
  while (at) {
    const parent = entries.get(at);
    if (!parent) return null;
    if (!sameRect(parent.rect, entry.rect)) return at;
    at = parent.parent;
  }
  return null;
}
function navNode(entries, id) {
  let node = entries.get(id)?.node;
  while (node?.kind === "stage" && node.child) node = node.child;
  return node?.id ?? id;
}
function sameRect(a, b) {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.h - b.h) < 1e-9;
}
function containsNode(node, id) {
  if (node.id === id) return true;
  if (node.kind === "stage") return !!node.child && containsNode(node.child, id);
  if (node.kind === "split") return node.children.some((c) => containsNode(c, id));
  return false;
}
function bestFit(camera, entries) {
  let best = "";
  let score = Infinity;
  for (const [id, { rect: r, node }] of entries) {
    if (node.kind === "stage" && node.child) continue;
    const size = Math.abs(Math.log(r.w / camera.w)) + Math.abs(Math.log(r.h / camera.h));
    const distance = Math.hypot(
      (r.x + r.w / 2 - camera.x - camera.w / 2) / camera.w,
      (r.y + r.h / 2 - camera.y - camera.h / 2) / camera.h
    );
    const next = size + distance * 2.5;
    if (next < score) {
      best = id;
      score = next;
    }
  }
  return best;
}
function hierarchyStep(entries, focused, direction, point) {
  const id = navNode(entries, focused);
  const entry = entries.get(id);
  if (!entry) return focused;
  if (direction === "out") return navParent(entries, id) ?? id;
  if (entry.node.kind !== "split") return id;
  const split = entry.node;
  const coordinate = split.axis === "x" ? point.x : point.y;
  for (const child of split.children.slice(0, -1)) {
    const r = entries.get(child.id).rect;
    if (coordinate < (split.axis === "x" ? r.x + r.w : r.y + r.h)) return navNode(entries, child.id);
  }
  return navNode(entries, split.children[split.children.length - 1].id);
}
function frameLeaves(root, ids) {
  if (!root) return null;
  const entries = focusLayout(root);
  const wanted = ids.filter((id) => entries.has(id));
  let best = entries.get(root.id);
  for (const entry of entries.values()) {
    if (entry.node.kind === "stage" && entry.node.child) continue;
    if (entry.rect.w * entry.rect.h < best.rect.w * best.rect.h && wanted.every((id) => containsNode(entry.node, id)))
      best = entry;
  }
  return best.node.id;
}
function rectangleCamera(a, b, viewport, camera) {
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ax = clamp((a.x - viewport.x) / viewport.w);
  const ay = clamp((a.y - viewport.y) / viewport.h);
  const bx = clamp((b.x - viewport.x) / viewport.w);
  const by = clamp((b.y - viewport.y) / viewport.h);
  return {
    x: camera.x + Math.min(ax, bx) * camera.w,
    y: camera.y + Math.min(ay, by) * camera.h,
    w: Math.abs(bx - ax) * camera.w,
    h: Math.abs(by - ay) * camera.h
  };
}
function recordVisit(visits, index, visit) {
  const previous = visits[index];
  if (previous && previous.id === visit.id && previous.leaves.join("|") === visit.leaves.join("|"))
    return { visits, index };
  const next = [...visits.slice(0, index + 1), visit];
  return { visits: next, index: next.length - 1 };
}
function savedFrameDestination(root, leaves) {
  const entries = layoutRects(root);
  const surviving = leaves.filter((id) => entries.has(id));
  return surviving.length ? frameLeaves(root, surviving) : null;
}
function maximizeTransition(entries, rootId, focused, id, session) {
  if (focused === id) {
    const destination = session?.id === id ? session.returnPath.find((key) => key !== id && entries.has(key)) ?? rootId : navParent(entries, id) ?? rootId;
    return { destination, session: null };
  }
  const returnPath = [];
  let at = focused;
  while (at) {
    returnPath.push(at);
    at = entries.get(at)?.parent ?? null;
  }
  return { destination: id, session: { id, returnPath } };
}
function dropEdge(point, rect) {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const x = (point.x - rect.x) / rect.w;
  const y = (point.y - rect.y) / rect.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const edges = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y]
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] <= 0.28 ? edges[0][0] : null;
}
function dropRects(rect, edge) {
  const slot = { ...rect };
  const remaining = { ...rect };
  const collapsed = { ...rect };
  if (edge === "left" || edge === "right") {
    slot.w = remaining.w = rect.w / 2;
    collapsed.w = 0;
    if (edge === "left") remaining.x += slot.w;
    else {
      slot.x += slot.w;
      collapsed.x += rect.w;
    }
  } else {
    slot.h = remaining.h = rect.h / 2;
    collapsed.h = 0;
    if (edge === "top") remaining.y += slot.h;
    else {
      slot.y += slot.h;
      collapsed.y += rect.h;
    }
  }
  return { slot, remaining, collapsed };
}
function seamTarget(group, boundary) {
  return {
    id: group.id,
    edge: group.axis === "x" ? "left" : "top",
    boundary,
    seam: {
      axis: group.axis,
      leaves: leafIds(group),
      before: group.children.slice(0, boundary).flatMap(leafIds)
    }
  };
}
function tileDropTarget(entries, id, edge) {
  const entry = entries.get(id);
  const parent = entry?.parent ? entries.get(entry.parent)?.node : null;
  if (parent?.kind === "split" && parent.axis === edgeAxis(edge)) {
    const index = parent.children.findIndex((child) => child.id === id);
    return seamTarget(parent, index + (edge === "right" || edge === "bottom" ? 1 : 0));
  }
  return { id, edge };
}
function frameDropTarget(group, point, width, height, radius) {
  if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return null;
  const distances = [
    ["left", point.x],
    ["right", width - point.x],
    ["top", point.y],
    ["bottom", height - point.y]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [edge, distance] = distances[0];
  if (distance > radius) return null;
  const axis = edgeAxis(edge);
  const after = edge === "right" || edge === "bottom";
  const inner = group.kind === "stage" && group.child ? group.child : group;
  if (inner.kind === "split" && inner.axis === axis)
    return seamTarget(inner, after ? inner.children.length : 0);
  return {
    id: group.id,
    edge,
    seam: { axis, leaves: leafIds(group), before: after ? leafIds(group) : [] }
  };
}
function insertAtSeam(root, seam, incoming, splitId) {
  const surviving = new Set(leafIds(root).filter((id) => seam.leaves.includes(id)));
  if (!surviving.size) return root;
  const insert = (node) => {
    if (node.kind === "stage" && node.child) {
      const ids = new Set(leafIds(node.child));
      if ([...surviving].every((id) => ids.has(id)) && !surviving.has(node.id))
        return { ...node, child: insert(node.child) };
    }
    if (node.kind === "split") {
      const container = node.children.findIndex((child) => {
        const ids = new Set(leafIds(child));
        return [...surviving].every((id) => ids.has(id));
      });
      if (container >= 0)
        return {
          ...node,
          children: node.children.map((child, i) => i === container ? insert(child) : child)
        };
      if (node.axis === seam.axis) {
        const index = node.children.findIndex(
          (child) => leafIds(child).some((id) => !seam.before.includes(id))
        );
        const children = [...node.children];
        const total = sum(node.weights);
        const share = 1 / (children.length + 1);
        const weights = node.weights.map((w) => w / total * (1 - share));
        children.splice(index < 0 ? children.length : index, 0, incoming);
        weights.splice(index < 0 ? node.children.length : index, 0, share);
        return { ...node, children, weights };
      }
    }
    const before = ![...surviving].some((id) => seam.before.includes(id));
    const edge = seam.axis === "x" ? before ? "left" : "right" : before ? "top" : "bottom";
    return insertBeside(node, node.id, incoming, edge, splitId);
  };
  return normalize(insert(root)) ?? root;
}
function applyDockTarget(root, target, incoming, splitId) {
  if (!root) return incoming;
  if (target.seam) return insertAtSeam(root, target.seam, incoming, splitId);
  return insertBeside(root, target.id, incoming, target.edge, splitId);
}

// src/runtime/drag.ts
var DROP_SLOT = "__trellis-drop-slot";
var SOURCE_SLOT = "__trellis-source-slot";
var THRESHOLD = 6;
var SETTLE_MS = 150;
var PICKUP_MS = 280;
var COMPACT = { w: 380, h: 260 };
var DESKTOP_SPLIT_MAX_PX = 64;
var MIN_SEAM_HIT_WIDTH = 8;
var OVERLAY_EDGE_BAND = 0.14;
function sameTarget(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "tab" && b.kind === "tab") return a.panel === b.panel && a.index === b.index;
  if (a.kind === "stage" && b.kind === "stage") return a.stage === b.stage;
  if (a.kind === "dock" && b.kind === "dock")
    return a.spec.id === b.spec.id && a.spec.edge === b.spec.edge && (a.spec.seam ? `${a.spec.seam.axis}|${a.spec.seam.before.join()}|${a.spec.seam.leaves.join()}` : "") === (b.spec.seam ? `${b.spec.seam.axis}|${b.spec.seam.before.join()}|${b.spec.seam.leaves.join()}` : "");
  return true;
}
var inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
function createDragController(host) {
  let session = null;
  let pickupFrame = 0;
  let cleanup = null;
  let suppressClickUntil = 0;
  const local = (e) => {
    const b = host.root.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  function begin(e, panel, viewId) {
    if (session || e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const doc = host.doc();
    const float = doc.floating.find((f) => f.panel.id === panel.id);
    const tab = viewId && panel.views.length > 1 ? viewId : null;
    const screen = host.lastRects.get(panel.id) ?? { x: 0, y: 0, w: 0, h: 0 };
    const p = local(e);
    session = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      active: false,
      origin: doc,
      lifted: panel,
      inDoc: true,
      pendingTab: tab,
      tabSort: null,
      excludedHost: null,
      tabOrigin: null,
      tabRollback: false,
      fromFloat: float ? float.layer : null,
      fromFrame: host.frameOnly(panel.id),
      base: /* @__PURE__ */ new Map(),
      sourceScreen: { ...screen },
      pdoc: doc,
      dropBase: /* @__PURE__ */ new Map(),
      collapsed: false,
      layoutTargets: /* @__PURE__ */ new Map(),
      floating: { ...screen },
      pickupAt: 0,
      compactFrom: 0,
      compactTo: 0,
      compactAmount: 0,
      desktopAmount: 0,
      sizeTick: performance.now(),
      pointer: p,
      grabX: screen.w ? (p.x - screen.x) / screen.w : 0.5,
      grabY: p.y - screen.y,
      target: null,
      candidate: null,
      targetTimer: void 0,
      dropLabel: ""
    };
    if (tab) {
      const dom = host.panelDom(panel.id);
      if (dom) {
        const items = panel.views.map((id) => ({ id, el: dom.tabs.get(id)?.el })).filter((x) => !!x.el).map(({ id, el }) => {
          const r = el.getBoundingClientRect();
          return { id, el, x: r.left, width: r.width };
        });
        const grabbed = items.find((item) => item.id === tab);
        session.tabSort = {
          row: dom.tabbar.getBoundingClientRect(),
          items,
          order: items.map((item) => item.id),
          grab: grabbed ? e.clientX - grabbed.x : 0,
          started: false
        };
      }
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const onMove = (ev) => {
      if (session && ev.pointerId === session.pointerId) move(ev);
    };
    const onUp = (ev) => {
      if (!session || ev.pointerId !== session.pointerId) return;
      move(ev);
      end(true);
    };
    const onCancel = (ev) => {
      if (session && ev.pointerId === session.pointerId) end(false);
    };
    window.addEventListener("pointermove", onMove, { signal });
    window.addEventListener("pointerup", onUp, { signal });
    window.addEventListener("pointercancel", onCancel, { signal });
    window.addEventListener("blur", () => end(false), { signal });
    window.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key === "Escape" && session) {
          ev.preventDefault();
          ev.stopPropagation();
          end(false);
        }
      },
      { signal, capture: true }
    );
    host.lifetime.add(() => controller.abort());
    cleanup = () => controller.abort();
  }
  function clearTabSort(d) {
    for (const item of d.tabSort?.items ?? []) {
      item.el.style.removeProperty("transform");
      item.el.removeAttribute("data-sorting");
      item.el.removeAttribute("data-dragging");
    }
  }
  function sortTabAtPointer(d, e) {
    const sort = d.tabSort;
    sort.started = true;
    const dragged = sort.items.find((item) => item.id === d.pendingTab);
    const list = host.panelDom(d.lifted.id)?.tablist.getBoundingClientRect() ?? sort.row;
    const left = Math.max(list.left, Math.min(list.right - dragged.width, e.clientX - sort.grab));
    let x = sort.items[0].x;
    let index = 0;
    for (const id of sort.order) {
      const item = sort.items.find((item2) => item2.id === id);
      if (id !== dragged.id && e.clientX > x + item.width / 2) index++;
      x += item.width;
    }
    sort.order = sort.order.filter((id) => id !== dragged.id);
    sort.order.splice(index, 0, dragged.id);
    x = sort.items[0].x;
    for (const id of sort.order) {
      const item = sort.items.find((item2) => item2.id === id);
      item.el.setAttribute("data-sorting", "");
      if (id === dragged.id) item.el.setAttribute("data-dragging", "");
      item.el.style.transform = `translateX(${(id === dragged.id ? left : x) - item.x}px)`;
      x += item.width;
    }
  }
  function move(e) {
    const d = session;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < THRESHOLD) return;
      if (d.pendingTab && d.tabSort) {
        const row = d.tabSort.row;
        if (e.clientX >= row.left && e.clientX <= row.right && e.clientY >= row.top && e.clientY <= row.bottom) {
          sortTabAtPointer(d, e);
          return;
        }
        clearTabSort(d);
      }
      activate(d);
    }
    d.pointer = local(e);
    retarget(d, e);
    host.schedule();
  }
  function activate(d) {
    host.closeMenus();
    d.active = true;
    let doc = host.doc();
    if (d.pendingTab) {
      const origin = host.lastRects.get(d.lifted.id) ?? d.sourceScreen;
      const hostPanel = d.lifted;
      const order = d.tabSort?.order ?? hostPanel.views;
      doc = reorderTabs(doc, hostPanel.id, order);
      doc = detachView(doc, d.pendingTab);
      d.lifted = { kind: "panel", id: uid("panel"), views: [d.pendingTab], selected: d.pendingTab };
      d.inDoc = false;
      d.excludedHost = hostPanel.id;
      d.tabOrigin = { ...origin };
      d.tabRollback = true;
      d.fromFloat = d.fromFloat ?? "stage";
      d.fromFrame = false;
      d.sourceScreen = { ...origin };
      d.pendingTab = null;
      host.setDoc(doc);
    }
    d.pdoc = doc;
    d.dropBase = layoutRects(doc.root);
    d.base = new Map([...d.dropBase].map(([id, e]) => [id, { ...e.rect }]));
    d.layoutTargets = restingLayout(d);
    d.pickupAt = performance.now();
    d.floating = { ...d.sourceScreen };
    try {
      host.root.setPointerCapture(d.pointerId);
    } catch {
    }
    host.root.setAttribute("data-dragging", "");
    host.busy(true);
    const tick = () => {
      if (session !== d) return;
      host.render();
      pickupFrame = host.lifetime.frame(tick);
    };
    pickupFrame = host.lifetime.frame(tick);
  }
  function retarget(d, e) {
    const viewport = host.viewport();
    const p = d.pointer;
    const point = host.fromScreen(p);
    const within = p.x >= 0 && p.y >= 0 && p.x <= viewport.w && p.y <= viewport.h;
    const layer = host.floatingLayer();
    const doc = d.pdoc;
    const stage = findStage(doc.root);
    const stageIsDesktop = !!stage && !stage.child && layer === "stage";
    const overlayMove = d.fromFloat === "overlay";
    const stageWorld = stage?.child ? d.dropBase.get(stage.id)?.rect : void 0;
    const stageMove = d.fromFloat === "stage" && !d.tabRollback && !!stageWorld && inside(point, stageWorld);
    const floatMove = overlayMove || stageMove;
    let next = null;
    if (within) {
      const overlays = doc.floating.filter((f) => f.layer === "overlay" && f.panel.id !== d.lifted.id).sort((a, b) => b.z - a.z);
      for (const f of overlays) {
        const r = host.lastRects.get(f.panel.id);
        if (!r || !inside(p, r)) continue;
        next = tabTarget(f.panel, p, r) ?? (dropEdge(p, r) ? null : { kind: "tab", panel: f.panel.id });
        return settle(d, filter(d, next));
      }
    }
    let hovered = null;
    if (within)
      for (const id of leafIds(doc.root)) {
        if (id === d.lifted.id) continue;
        const r = d.dropBase.get(id)?.rect;
        if (r && inside(point, r)) {
          hovered = id;
          break;
        }
      }
    const hoveredNode = hovered ? findNode(doc.root, hovered) : null;
    if (hovered && hoveredNode?.kind === "panel") {
      const screen = host.panelScreen(d.dropBase.get(hovered).rect);
      const bar = tabTarget(hoveredNode, p, screen);
      if (bar) next = bar;
      else {
        const edge = floatMove ? overlayEdge(p, screen) : dropEdge(point, d.dropBase.get(hovered).rect);
        next = edge ? { kind: "dock", spec: tileDropTarget(d.dropBase, hovered, edge) } : floatMove ? { kind: "float" } : { kind: "tab", panel: hovered };
      }
    }
    const radius = Math.max(host.inset(), MIN_SEAM_HIT_WIDTH / 2);
    let closest = radius;
    if (within)
      for (const [id, entry] of d.dropBase) {
        const node = entry.node;
        if (node.kind !== "split") continue;
        const group2 = host.toScreen(entry.rect);
        if (!inside(p, group2)) continue;
        node.children.slice(1).forEach((child, index) => {
          const r = host.toScreen(d.dropBase.get(child.id).rect);
          const distance = Math.abs(node.axis === "x" ? p.x - r.x : p.y - r.y);
          if (distance >= closest) return;
          if (!leafIds(node).some((leaf) => leaf !== d.lifted.id)) return;
          closest = distance;
          next = { kind: "dock", spec: seamTarget(node, index + 1) };
        });
        void id;
      }
    if (within && stage && !stage.child && closest === radius) {
      const world = d.dropBase.get(stage.id)?.rect;
      if (world && inside(point, world)) {
        const s = host.panelScreen(world);
        const distances = [
          ["left", p.x - s.x],
          ["right", s.x + s.w - p.x],
          ["top", p.y - s.y],
          ["bottom", s.y + s.h - p.y]
        ];
        distances.sort((a, b) => a[1] - b[1]);
        const dimension = distances[0][0] === "left" || distances[0][0] === "right" ? s.w : s.h;
        const nearEdge = distances[0][1] <= Math.min(DESKTOP_SPLIT_MAX_PX, dimension * 0.28);
        next = nearEdge ? { kind: "dock", spec: tileDropTarget(d.dropBase, stage.id, distances[0][0]) } : stageIsDesktop ? { kind: "float" } : { kind: "stage", stage: stage.id };
      }
    }
    if (next?.kind === "float" && stageIsDesktop)
      for (const f of [...doc.floating].filter((f2) => f2.layer === "stage").sort((a, b) => b.z - a.z)) {
        if (f.panel.id === d.lifted.id) continue;
        const r = host.floatWorld(f.panel.id);
        if (!r || !inside(point, r)) continue;
        const screen = host.lastRects.get(f.panel.id);
        next = (screen && tabTarget(f.panel, p, screen)) ?? (dropEdge(point, r) ? next : { kind: "tab", panel: f.panel.id });
        break;
      }
    const group = host.framedNode() ?? doc.root;
    if (group) {
      const frame = frameDropTarget(
        group,
        p,
        viewport.w,
        viewport.h,
        Math.max(host.inset() * 2, MIN_SEAM_HIT_WIDTH)
      );
      if (frame && leafIds(group).some((id) => id !== d.lifted.id)) next = { kind: "dock", spec: frame };
    }
    if (next?.kind === "tab" && next.panel === d.excludedHost) {
      const hostFloat = doc.floating.find((f) => f.panel.id === d.excludedHost);
      next = hostFloat && hostFloat.layer === "stage" ? { kind: "float" } : null;
    }
    if (!next && within && (overlayMove || stageMove)) next = { kind: "float" };
    settle(d, filter(d, next));
    void e;
  }
  function tabTarget(panel, p, screen) {
    const bar = host.tabbarHeight(panel);
    if (!bar || !(p.x >= screen.x && p.x <= screen.x + screen.w && p.y >= screen.y && p.y <= screen.y + bar))
      return null;
    const dom = host.panelDom(panel.id);
    const rootBox = host.root.getBoundingClientRect();
    let index = panel.views.length;
    if (dom)
      for (let i = 0; i < panel.views.length; i++) {
        const el = dom.tabs.get(panel.views[i])?.el;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (p.x < r.left - rootBox.left + r.width / 2) {
          index = i;
          break;
        }
      }
    return { kind: "tab", panel: panel.id, index };
  }
  function overlayEdge(p, r) {
    const x = (p.x - r.x) / r.w;
    const y = (p.y - r.y) / r.h;
    const edges = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y]
    ];
    edges.sort((a, b) => a[1] - b[1]);
    return edges[0][1] <= OVERLAY_EDGE_BAND ? edges[0][0] : null;
  }
  function filter(d, next) {
    if (!next) return null;
    const views = d.lifted.views;
    const layer = host.floatingLayer();
    if (next.kind === "float") return layer && host.allowed(views, "floating") ? next : null;
    if (next.kind === "stage") return host.allowed(views, "stage") ? next : null;
    const doc = d.pdoc;
    const stage = findStage(doc.root);
    const inStage = (id) => !!stage?.child && id !== stage.id && containsNode(stage.child, id);
    if (next.kind === "tab") {
      const float = doc.floating.find((f) => f.panel.id === next.panel);
      return host.allowed(views, float ? "floating" : inStage(next.panel) ? "stage" : "side") ? next : null;
    }
    const spec = next.spec;
    const region = spec.seam ? spec.seam.leaves.length && spec.seam.leaves.every((id) => inStage(id)) && inStage(spec.id) ? "stage" : "side" : inStage(spec.id) ? "stage" : "side";
    return host.allowed(views, region) ? next : null;
  }
  function settle(d, next) {
    host.root.setAttribute("data-drop", next ? next.kind : "none");
    if (sameTarget(next, d.candidate)) return;
    d.candidate = next;
    host.lifetime.clearTimeout(d.targetTimer);
    d.targetTimer = void 0;
    if (sameTarget(next, d.target)) return;
    d.targetTimer = host.lifetime.timeout(() => {
      d.targetTimer = void 0;
      if (session !== d) return;
      apply(d, d.candidate);
      host.render();
    }, SETTLE_MS);
  }
  function seamOrigin(d, preview, slot) {
    const parentId = preview.get(DROP_SLOT)?.parent;
    const parent = parentId ? preview.get(parentId)?.node : null;
    const collapsedAtCenter = parent?.kind === "split" && parent.axis === "y" ? { ...slot, y: slot.y + slot.h / 2, h: 0 } : { ...slot, x: slot.x + slot.w / 2, w: 0 };
    if (!parent || parent.kind !== "split") return collapsedAtCenter;
    const index = parent.children.findIndex((c) => c.id === DROP_SLOT);
    const after = parent.children[index + 1];
    const before = parent.children[index - 1];
    const neighbour = after ? currentWorld(d, after.id) : before ? currentWorld(d, before.id) : null;
    if (!neighbour) return collapsedAtCenter;
    if (parent.axis === "x") {
      const x = after ? neighbour.x : neighbour.x + neighbour.w;
      return { ...slot, x, w: 0 };
    }
    const y = after ? neighbour.y : neighbour.y + neighbour.h;
    return { ...slot, y, h: 0 };
  }
  function restingLayout(d) {
    const rects = new Map(d.base);
    for (const [id, entry] of d.dropBase) rects.set(id, entry.rect);
    if (d.collapsed) rects.set(SOURCE_SLOT, collapsedSource(d));
    else if (d.inDoc && !d.fromFloat && d.base.get(d.lifted.id))
      rects.set(SOURCE_SLOT, d.base.get(d.lifted.id));
    return rects;
  }
  function collapsedSource(d) {
    const entry = layoutRects(d.origin.root).get(d.lifted.id);
    const rect = { ...d.base.get(d.lifted.id) ?? entry?.rect ?? { x: 0, y: 0, w: 0, h: 0 } };
    const parent = entry?.parent ? layoutRects(d.origin.root).get(entry.parent)?.node : null;
    if (!parent || parent.kind !== "split") return { ...rect, w: 0 };
    const hasNext = parent.children.findIndex((c) => c.id === d.lifted.id) < parent.children.length - 1;
    if (parent.axis === "x") {
      if (!hasNext) rect.x += rect.w;
      rect.w = 0;
    } else {
      if (!hasNext) rect.y += rect.h;
      rect.h = 0;
    }
    return rect;
  }
  const worldOf = (id) => host.fromScreenRect(host.lastRects.get(id));
  function currentWorld(d, id) {
    const own = worldOf(id);
    if (own) return own;
    const node = findNode(d.pdoc.root, id);
    const rects = node ? leafIds(node).map(worldOf).filter((r) => !!r) : [];
    if (!rects.length) return d.dropBase.get(id)?.rect ?? null;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((r) => r.x + r.w)) - x,
      h: Math.max(...rects.map((r) => r.y + r.h)) - y
    };
  }
  function apply(d, next) {
    if (sameTarget(next, d.target)) return;
    const previous = new Map(host.lastRects);
    const parent = layoutRects(d.origin.root).get(d.lifted.id)?.parent;
    if (next && d.inDoc && !d.fromFloat && !d.collapsed && parent) {
      d.collapsed = true;
      d.pdoc = removePanel(d.pdoc, d.lifted.id);
      d.dropBase = layoutRects(d.pdoc.root);
    }
    d.layoutTargets = restingLayout(d);
    d.dropLabel = "";
    const setSlotFrom = (world) => previous.set(DROP_SLOT, host.panelScreen(world));
    if (next?.kind === "tab") {
      const world = d.dropBase.get(next.panel)?.rect ?? host.floatWorld(next.panel) ?? worldOf(next.panel);
      if (world) {
        d.layoutTargets.set(DROP_SLOT, world);
        setSlotFrom(world);
      } else {
        const screen = host.lastRects.get(next.panel);
        if (screen) {
          d.layoutTargets.set(DROP_SLOT, host.fromScreenRect(screen));
          previous.set(DROP_SLOT, screen);
        }
      }
      d.dropLabel = "Add as tab";
    } else if (next?.kind === "stage") {
      const world = d.dropBase.get(next.stage).rect;
      d.layoutTargets.set(DROP_SLOT, world);
      setSlotFrom({ ...world, x: world.x + world.w / 2, y: world.y + world.h / 2, w: 0, h: 0 });
    } else if (next?.kind === "dock") {
      const placeholder = {
        kind: "panel",
        id: DROP_SLOT,
        views: [DROP_SLOT],
        selected: DROP_SLOT
      };
      const spec = next.spec;
      if (spec.seam || !d.dropBase.get(spec.id)) {
        const previewRoot = applyDockTarget(d.pdoc.root, spec, placeholder, "__trellis-seam-preview");
        const preview = layoutRects(previewRoot);
        for (const [id, entry] of preview) d.layoutTargets.set(id, entry.rect);
        const slot = preview.get(DROP_SLOT)?.rect;
        if (slot) setSlotFrom(seamOrigin(d, preview, slot));
      } else {
        const r = dropRects(d.dropBase.get(spec.id).rect, spec.edge);
        d.layoutTargets.set(spec.id, r.remaining);
        d.layoutTargets.set(DROP_SLOT, r.slot);
        const current = currentWorld(d, spec.id);
        setSlotFrom(current ? dropRects(current, spec.edge).collapsed : r.collapsed);
      }
    } else if (!next && d.target && d.target.kind !== "float") {
      const slot = previous.get(DROP_SLOT);
      const world = slot ? host.fromScreenRect(slot) : null;
      if (world) {
        const edge = d.target.kind === "dock" ? d.target.spec.edge : "left";
        d.layoutTargets.set(
          DROP_SLOT,
          edge === "left" || edge === "right" ? { ...world, x: world.x + world.w / 2, w: 0 } : { ...world, y: world.y + world.h / 2, h: 0 }
        );
      }
    }
    if (d.collapsed && !previous.has(SOURCE_SLOT)) {
      const base = d.base.get(d.lifted.id);
      if (base) previous.set(SOURCE_SLOT, host.panelScreen(base));
    }
    d.target = next;
    if (!host.reduced()) host.tween.begin(previous, performance.now());
  }
  function liftedRect() {
    const d = session;
    const original = d.sourceScreen;
    const doc = d.pdoc;
    const stage = findStage(doc.root);
    const desktop = stage && !stage.child && host.floatingLayer() === "stage" && d.dropBase.get(stage.id) ? host.panelScreen(d.dropBase.get(stage.id).rect) : null;
    const source = d.collapsed ? null : d.tabOrigin ?? (d.fromFloat && !d.fromFrame ? desktop ?? (d.fromFloat === "overlay" ? fullViewport() : original) : original);
    const now = performance.now();
    const amount = host.reduced() ? 1 : 1 - Math.exp(-(now - d.sizeTick) / 60);
    d.sizeTick = now;
    d.desktopAmount += ((desktop && inside(d.pointer, desktop) ? 1 : 0) - d.desktopAmount) * amount;
    const compactTo = source && inside(d.pointer, source) || !d.fromFrame && desktop && inside(d.pointer, desktop) ? 0 : 1;
    if (compactTo !== d.compactTo) {
      d.compactFrom = d.compactAmount;
      d.compactTo = compactTo;
      d.pickupAt = now;
    }
    const progress = host.reduced() ? 1 : Math.min(1, (now - d.pickupAt) / PICKUP_MS);
    const eased = 1 - (1 - progress) ** 3;
    d.compactAmount = d.compactFrom + (d.compactTo - d.compactFrom) * eased;
    const targetScale = Math.min(1, COMPACT.w / Math.max(1, original.w), COMPACT.h / Math.max(1, original.h));
    const scale = 1 + (targetScale - 1) * d.compactAmount;
    let w = d.fromFrame ? original.w + (COMPACT.w - original.w) * d.compactAmount : original.w * scale;
    let h2 = d.fromFrame ? original.h + (COMPACT.h - original.h) * d.compactAmount : original.h * scale;
    const min = host.minSize(d.lifted.views);
    const bar = host.tabbarHeight(d.lifted);
    w += (Math.max(w, min.w + host.inset() * 2) - w) * d.desktopAmount;
    h2 += (Math.max(h2, min.h + bar + host.inset() * 2) - h2) * d.desktopAmount;
    const grabY = d.grabY + (Math.min(d.grabY, 18) - d.grabY) * d.compactAmount;
    d.floating = { x: d.pointer.x - w * d.grabX, y: d.pointer.y - grabY, w, h: h2 };
    return d.floating;
  }
  const fullViewport = () => ({ x: 0, y: 0, ...host.viewport() });
  function end(commit) {
    const d = session;
    if (!d) return;
    host.lifetime.clearTimeout(d.targetTimer);
    if (commit && d.active) apply(d, d.candidate);
    host.lifetime.cancelFrame(pickupFrame);
    pickupFrame = 0;
    session = null;
    cleanup?.();
    cleanup = null;
    try {
      if (host.root.hasPointerCapture(d.pointerId)) host.root.releasePointerCapture(d.pointerId);
    } catch {
    }
    host.root.removeAttribute("data-dragging");
    host.root.removeAttribute("data-drop");
    if (!d.active) return endPending(d, commit);
    suppressClickUntil = performance.now() + 350;
    host.busy(false);
    const lifted = d.lifted;
    const from = new Map(host.lastRects);
    from.set(lifted.id, { ...d.floating });
    const target = commit ? d.target : null;
    if (!target) {
      host.setDoc(d.origin);
      host.commit(d.origin, from, lifted.id);
      return;
    }
    const base = host.doc();
    const without = d.inDoc ? removePanel(base, lifted.id) : base;
    let next;
    const layer = host.floatingLayer() || "overlay";
    if (target.kind === "tab")
      next = insertPanel(without, lifted, { into: target.panel, index: target.index });
    else if (target.kind === "stage") next = insertPanel(without, lifted, { into: target.stage });
    else if (target.kind === "dock") {
      const root = applyDockTarget(without.root, target.spec, lifted, uid("split"));
      next = { ...without, root };
    } else {
      const floatLayer = d.fromFloat === "overlay" ? "overlay" : layer;
      next = floatPanel(without, lifted, floatRect(d, without, floatLayer), floatLayer);
    }
    const repositioning = target.kind === "float" && !!d.fromFloat && !d.tabRollback;
    host.setDoc(d.origin);
    host.commit(next, from, repositioning || target.kind === "tab" ? null : lifted.id);
    host.moved(lifted, d.fromFloat && !d.tabRollback ? "floating" : "docked", target.kind);
    host.announce("Moved");
  }
  function floatRect(d, next, layer) {
    const viewport = host.viewport();
    const container = layer === "overlay" ? { x: 0, y: 0, w: viewport.w, h: viewport.h } : (() => {
      const stage = findStage(next.root);
      const world = stage ? layoutRects(next.root).get(stage.id)?.rect : null;
      return host.toScreen(world ?? { x: 0, y: 0, w: 1, h: 1 });
    })();
    const current = d.fromFloat && !d.tabRollback ? host.lastRects.get(d.lifted.id) : null;
    const original = d.fromFrame ? d.floating : current ?? d.sourceScreen;
    const min = host.minSize(d.lifted.views);
    const bar = host.tabbarHeight(d.lifted);
    let w;
    let h2;
    if (d.fromFloat && !d.fromFrame && !d.tabRollback) {
      w = original.w;
      h2 = original.h;
    } else {
      w = Math.min(container.w * (2 / 3), original.w);
      h2 = Math.min(container.h * (2 / 3), original.h);
    }
    w = Math.max(w, min.w + host.inset() * 2);
    h2 = Math.max(h2, min.h + bar + host.inset() * 2);
    const grabY = Math.min(d.grabY, 18 + (d.grabY - 18) * (1 - d.compactAmount));
    const x = d.pointer.x - w * d.grabX;
    const y = d.pointer.y - grabY;
    return {
      x: (x - container.x) / container.w,
      y: (y - container.y) / container.h,
      w: w / container.w,
      h: h2 / container.h
    };
  }
  function endPending(d, commit) {
    const sort = d.tabSort;
    const positions = new Map(
      sort?.items.map((item) => [item.id, item.el.getBoundingClientRect().left]) ?? []
    );
    clearTabSort(d);
    if (!commit || !sort?.started || !d.pendingTab) return;
    suppressClickUntil = performance.now() + 350;
    let next = reorderTabs(host.doc(), d.lifted.id, sort.order);
    next = selectView(next, d.pendingTab);
    host.commit(next, /* @__PURE__ */ new Map(), null);
    if (host.reduced()) return;
    for (const item of sort.items) {
      const before = positions.get(item.id);
      if (before === void 0) continue;
      const after = item.el.getBoundingClientRect().left;
      if (Math.abs(before - after) < 0.5) continue;
      item.el.animate([{ transform: `translateX(${before - after}px)` }, { transform: "translateX(0)" }], {
        duration: 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
      });
    }
  }
  return {
    get session() {
      return session;
    },
    get active() {
      return !!session?.active;
    },
    /** Clicks right after a drag or sort are swallowed. */
    get suppressClicks() {
      return performance.now() < suppressClickUntil;
    },
    begin,
    cancel: () => end(false),
    liftedRect,
    /** World rect overrides for docked nodes and the two slots while dragging. */
    layoutTargets: () => session?.active ? session.layoutTargets : null,
    dropLabel: () => session?.dropLabel ?? ""
  };
}

// src/runtime/dom.ts
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === void 0 || value === false) continue;
    if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children);
  return el;
}
var icons = {
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
};
function setStyle(el, key, value) {
  const cache = el.__trellis ??= {};
  if (cache[key] === value) return;
  cache[key] = value;
  if (key.startsWith("--")) el.style.setProperty(key, value);
  else el.style[key] = value;
}
function setAttr(el, key, value) {
  if (value === null) {
    if (el.hasAttribute(key)) el.removeAttribute(key);
  } else if (el.getAttribute(key) !== value) el.setAttribute(key, value);
}
function place(el, r, round) {
  let { x, y, w, h: h2 } = r;
  if (round) {
    const x2 = Math.round(x + w);
    const y2 = Math.round(y + h2);
    x = Math.round(x);
    y = Math.round(y);
    w = x2 - x;
    h2 = y2 - y;
  }
  setStyle(el, "transform", `translate(${x}px, ${y}px)`);
  setStyle(el, "width", `${Math.max(0, w)}px`);
  setStyle(el, "height", `${Math.max(0, h2)}px`);
}

// src/runtime/motion.ts
var MOTION = {
  spring: { stiffness: 210, damping: 29, maxStep: 0.032, epsilon: 1e-4 },
  layoutMs: 460,
  pickupMs: 280,
  appearMs: 220
};
var easeOutQuint = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 5;
function lerpRect(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t
  };
}
var RectSpring = class {
  value;
  target;
  velocity = { x: 0, y: 0, w: 0, h: 0 };
  constructor(initial) {
    this.value = { ...initial };
    this.target = { ...initial };
  }
  get moving() {
    return !sameRect2(this.value, this.target) || !isZero(this.velocity);
  }
  /** Returns true while still moving. */
  step(dt) {
    const { stiffness, damping, maxStep, epsilon } = MOTION.spring;
    dt = Math.min(dt || 0.016, maxStep);
    let error = 0;
    for (const key of ["x", "y", "w", "h"]) {
      this.velocity[key] += ((this.target[key] - this.value[key]) * stiffness - this.velocity[key] * damping) * dt;
      this.value[key] += this.velocity[key] * dt;
      error += Math.abs(this.target[key] - this.value[key]) + Math.abs(this.velocity[key]) * 0.1;
    }
    if (error <= epsilon) {
      this.finish();
      return false;
    }
    return true;
  }
  finish() {
    this.value = { ...this.target };
    this.velocity = { x: 0, y: 0, w: 0, h: 0 };
  }
  jump(rect) {
    this.target = { ...rect };
    this.finish();
  }
};
function sameRect2(a, b, epsilon = 1e-9) {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon && Math.abs(a.w - b.w) < epsilon && Math.abs(a.h - b.h) < epsilon;
}
function isZero(r) {
  return sameRect2(r, { x: 0, y: 0, w: 0, h: 0 });
}
var LayoutTween = class {
  from = /* @__PURE__ */ new Map();
  start = 0;
  progress = 1;
  begin(from, now) {
    this.from = from;
    this.start = now;
    this.progress = from.size ? 0 : 1;
  }
  step(now, duration = MOTION.layoutMs) {
    const elapsed = duration > 0 ? (now - this.start) / duration : 1;
    this.progress = easeOutQuint(elapsed);
    if (elapsed >= 1) this.stop();
    return this.progress < 1;
  }
  stop() {
    this.progress = 1;
    this.from.clear();
  }
  get active() {
    return this.progress < 1;
  }
  apply(id, target) {
    const from = this.from.get(id);
    return from && this.progress < 1 ? lerpRect(from, target, this.progress) : target;
  }
};
function cubicBezier(x1, y1, x2, y2) {
  const sample = (a, b, t) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i++) {
      const v = sample(x1, x2, t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sample(y1, y2, t);
  };
}
var DOCK_EASE = cubicBezier(0.2, 0.75, 0.2, 1);
var DOCK_MS = { hide: 300, restore: 380 };

// src/runtime/navigation.ts
var MAX_HISTORY = 100;
function createNavigator(host) {
  let entries = /* @__PURE__ */ new Map();
  let framed = null;
  let framedLeaves = [];
  let visits = [{ id: "", leaves: [] }];
  let visitIndex = 0;
  let session = null;
  let overviewReturn = null;
  let framings = [];
  let gesture = false;
  let suppressClickUntil = 0;
  let wheelTimer;
  const rootId = () => host.doc().root?.id ?? "";
  const on = () => !!host.mode();
  const free = () => host.mode() === "free";
  function sync() {
    entries = focusLayout(host.doc().root);
    if (framed && !entries.has(framed)) {
      const surviving = framedLeaves.filter((id) => entries.has(id));
      const next = surviving.length ? frameLeaves(host.doc().root, surviving) : null;
      framed = next && next !== rootId() ? next : null;
      framedLeaves = framed ? leafIds(entries.get(framed).node) : [];
    } else if (framed) framedLeaves = leafIds(entries.get(framed).node);
    if (session && !entries.has(session.id)) session = null;
    retarget();
  }
  function rectOf(id) {
    return id && entries.get(id)?.rect || UNIT;
  }
  function retarget() {
    const target = rectOf(framed);
    if (!sameRect2(host.camera.target, target)) {
      host.camera.target = { ...target };
      if (host.reduced()) host.camera.finish();
      host.schedule();
    }
    host.root.toggleAttribute("data-framed", !!framed);
  }
  function focus(id, record = true) {
    if (!on()) id = null;
    const doc = host.doc();
    if (id && doc.floating.some((f) => f.panel.id === id)) id = findStage(doc.root)?.id ?? null;
    if (id && !entries.has(id)) id = null;
    if (id) id = navNode(entries, id);
    if (id === rootId()) id = null;
    if (session && session.id !== id) session = null;
    if (record) {
      const visit = { id: id ?? rootId(), leaves: leafIds(id ? entries.get(id).node : doc.root) };
      ({ visits, index: visitIndex } = recordVisit(visits, visitIndex, visit));
      if (visits.length > MAX_HISTORY) {
        visits = visits.slice(-MAX_HISTORY);
        visitIndex = visits.length - 1;
      }
    }
    endGesture();
    const changed = framed !== id;
    framed = id;
    framedLeaves = id ? leafIds(entries.get(id).node) : [];
    retarget();
    if (changed) host.changed();
  }
  function endGesture() {
    host.lifetime.clearTimeout(wheelTimer);
    snapEl.removeAttribute("data-visible");
    if (gesture) {
      gesture = false;
      host.setGesture(false);
    }
  }
  function toggle(id) {
    if (!on()) return false;
    const doc = host.doc();
    if (doc.floating.some((f) => f.panel.id === id)) return false;
    const node = entries.has(id) ? id : null;
    if (!node) return false;
    const next = maximizeTransition(entries, rootId(), framed ?? rootId(), navNode(entries, node), session);
    focus(next.destination);
    session = next.session;
    return true;
  }
  function stepOut() {
    if (!framed) return;
    focus(navParent(entries, framed) ?? null);
  }
  function stepIn(point) {
    const p = point ?? host.fromScreen({ x: host.viewport().w / 2, y: host.viewport().h / 2 });
    focus(hierarchyStep(entries, framed ?? rootId(), "in", p));
  }
  function historyGo(direction) {
    const next = visitIndex + direction;
    if (next < 0 || next >= visits.length) return;
    visitIndex = next;
    session = null;
    const destination = savedFrameDestination(host.doc().root, visits[next].leaves);
    focus(destination ?? findStage(host.doc().root)?.id ?? null, false);
  }
  function toggleOverview() {
    if (!framed && overviewReturn) {
      const leaves = overviewReturn;
      overviewReturn = null;
      focus(savedFrameDestination(host.doc().root, leaves));
    } else if (framed) {
      overviewReturn = [...framedLeaves];
      focus(null);
    }
  }
  function frame(target) {
    if (target === "all") return focus(null);
    if (target === "stage") return focus(findStage(host.doc().root)?.id ?? null);
    const ids = (Array.isArray(target) ? target : [target]).flatMap(
      (id) => entries.has(id) ? leafIds(entries.get(id).node) : [panelOf(id)].filter((x) => !!x)
    );
    if (!ids.length) return;
    focus(frameLeaves(host.doc().root, ids));
  }
  function panelOf(viewId) {
    const doc = host.doc();
    for (const id of leafIds(doc.root)) {
      const node = entries.get(id)?.node;
      if (node?.kind === "panel" && node.views.includes(viewId)) return id;
    }
    return null;
  }
  function ensureVisible(panelId) {
    if (!framed) return;
    const doc = host.doc();
    const node = entries.get(framed)?.node;
    if (!node) return;
    const float = doc.floating.find((f) => f.panel.id === panelId);
    if (float) {
      if (float.layer === "overlay") return;
      const stage = findStage(doc.root);
      if (stage && leafIds(node).includes(stage.id)) return;
      if (stage && (node.id === stage.id || contains(node, stage.id))) return;
      focus(stage?.id ?? null);
      return;
    }
    if (contains(node, panelId)) return;
    focus(frameLeaves(doc.root, [...framedLeaves, panelId]));
  }
  const contains = (node, id) => node.id === id || node.kind === "split" && node.children.some((c) => contains(c, id)) || node.kind === "stage" && !!node.child && contains(node.child, id);
  const bounds = () => host.root.getBoundingClientRect();
  function zoom(factor, clientX, clientY, panX = 0, panY = 0) {
    if (marquee || !entries.size) return;
    if (!gesture) {
      gesture = true;
      host.setGesture(true);
    }
    host.camera.velocity = { x: 0, y: 0, w: 0, h: 0 };
    const b = bounds();
    const c = host.camera.value;
    const px = (clientX - b.left) / b.width;
    const py = (clientY - b.top) / b.height;
    const min = Math.min(...[...entries.values()].map((e) => Math.min(e.rect.w, e.rect.h))) * 0.65;
    factor = Math.max(min / Math.min(c.w, c.h), Math.min(factor, 1.35 / Math.max(c.w, c.h)));
    const next = {
      x: c.x + c.w * px * (1 - factor) - panX / b.width * c.w,
      y: c.y + c.h * py * (1 - factor) - panY / b.height * c.h,
      w: c.w * factor,
      h: c.h * factor
    };
    next.x = Math.max(-next.w * 0.3, Math.min(1 - next.w * 0.7, next.x));
    next.y = Math.max(-next.h * 0.3, Math.min(1 - next.h * 0.7, next.y));
    host.camera.jump(next);
    host.render();
    const candidate = entries.get(bestFit(host.camera.value, entries));
    if (candidate) {
      place2(snapEl, host.panelScreen(candidate.rect));
      snapEl.setAttribute("data-visible", "");
    }
  }
  function finishGesture() {
    if (!gesture) return;
    focus(bestFit(host.camera.value, entries));
  }
  let hierarchyWheel = { last: -Infinity, total: 0, steppedAt: -Infinity, direction: 0 };
  const resetHierarchyWheel = () => hierarchyWheel = { last: -Infinity, total: 0, steppedAt: -Infinity, direction: 0 };
  function handleHierarchyWheel(e) {
    if (!e.shiftKey) {
      resetHierarchyWheel();
      return false;
    }
    e.preventDefault();
    if (host.busy() || dragZoom || marquee) return true;
    const now = performance.now();
    const raw = e.deltaY || e.deltaX;
    const direction = Math.sign(raw);
    if (!direction) return true;
    if (now - hierarchyWheel.last > 260 || direction !== hierarchyWheel.direction) resetHierarchyWheel();
    hierarchyWheel.last = now;
    hierarchyWheel.direction = direction;
    hierarchyWheel.total += raw * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.viewport().h : 1);
    if (now - hierarchyWheel.steppedAt >= 140 && Math.abs(hierarchyWheel.total) >= 12) {
      hierarchyWheel.steppedAt = now;
      const b = bounds();
      const point = host.fromScreen({ x: e.clientX - b.left, y: e.clientY - b.top });
      const next = hierarchyStep(entries, framed ?? rootId(), hierarchyWheel.total > 0 ? "out" : "in", point);
      hierarchyWheel.total = 0;
      focus(next);
    }
    return true;
  }
  host.lifetime.listen(
    host.root,
    "wheel",
    (e) => {
      if (!free()) return;
      if (handleHierarchyWheel(e)) return;
      const target = e.target;
      if (!e.ctrlKey && !e.altKey && host.contentOwnsWheel(target, e)) return;
      if (target.closest?.("[data-trellis-part=tabs]") && !e.ctrlKey) {
        const list = target.closest("[data-trellis-part=tabs]");
        if (list.scrollWidth > list.clientWidth) return;
      }
      if (target.closest?.(".trellis-menu")) return;
      e.preventDefault();
      if (host.busy() || dragZoom || marquee) return;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.viewport().h : 1);
      zoom(
        Math.exp(Math.max(-0.3, Math.min(0.3, delta * (e.ctrlKey ? 9e-3 : 3e-3)))),
        e.clientX,
        e.clientY
      );
      host.lifetime.clearTimeout(wheelTimer);
      wheelTimer = host.lifetime.timeout(finishGesture, 180);
    },
    { passive: false }
  );
  host.lifetime.listen(host.root, "keyup", (e) => {
    if (e.key === "Shift") resetHierarchyWheel();
  });
  host.lifetime.listen(
    window,
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !marquee && !dragZoom) return;
      e.preventDefault();
      e.stopPropagation();
      finishMarquee(false);
      finishDragZoom();
    },
    { capture: true }
  );
  host.lifetime.listen(window, "blur", () => {
    resetHierarchyWheel();
    finishDragZoom();
    finishMarquee(false);
  });
  const marqueeEl = h("div", { "data-trellis-part": "marquee", "aria-hidden": "true" });
  const snapEl = h(
    "div",
    { "data-trellis-part": "snap-preview", "aria-hidden": "true" },
    h("span", {}, "Release to focus")
  );
  host.root.append(snapEl);
  host.lifetime.add(() => snapEl.remove());
  const candidateEl = h("div", { "data-trellis-part": "marquee-target", "aria-hidden": "true" }, h("span"));
  host.root.append(marqueeEl, candidateEl);
  host.lifetime.add(() => {
    marqueeEl.remove();
    candidateEl.remove();
  });
  let marquee = null;
  let dragZoom = null;
  const place2 = (el, r) => {
    el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    el.style.width = `${Math.max(0, r.w)}px`;
    el.style.height = `${Math.max(0, r.h)}px`;
  };
  function moveMarquee(e) {
    if (!marquee || marquee.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const m = marquee;
    const world = rectangleCamera(m.start, { x: e.clientX, y: e.clientY }, m.viewport, m.view);
    const screen = host.toScreen(world);
    place2(marqueeEl, screen);
    m.candidate = screen.w >= 8 && screen.h >= 8 ? bestFit(world, entries) : null;
    candidateEl.toggleAttribute("data-visible", !!m.candidate);
    if (m.candidate) {
      const entry = entries.get(m.candidate);
      place2(candidateEl, host.panelScreen(entry.rect));
      candidateEl.querySelector("span").textContent = `Release to focus ${host.titleOf(entry.node)} \xB7 Esc to cancel`;
    }
  }
  function finishMarquee(commit) {
    if (!marquee) return;
    const m = marquee;
    marquee = null;
    suppressClickUntil = performance.now() + 350;
    host.root.removeAttribute("data-marquee");
    candidateEl.removeAttribute("data-visible");
    try {
      if (host.root.hasPointerCapture(m.pointerId)) host.root.releasePointerCapture(m.pointerId);
    } catch {
    }
    focus(commit && m.candidate ? m.candidate : framed);
  }
  function finishDragZoom() {
    if (!dragZoom) return;
    const { pointerId } = dragZoom;
    dragZoom = null;
    suppressClickUntil = performance.now() + 350;
    host.root.removeAttribute("data-drag-zoom");
    try {
      if (host.root.hasPointerCapture(pointerId)) host.root.releasePointerCapture(pointerId);
    } catch {
    }
    finishGesture();
  }
  host.lifetime.listen(
    host.root,
    "pointerdown",
    (e) => {
      if (!free() || host.busy() || e.button !== 0 || e.pointerType === "touch") return;
      if (e.shiftKey && !dragZoom) {
        e.preventDefault();
        e.stopPropagation();
        endGesture();
        const r = bounds();
        marquee = {
          pointerId: e.pointerId,
          start: { x: e.clientX, y: e.clientY },
          view: { ...host.camera.value },
          viewport: { x: r.left, y: r.top, w: r.width, h: r.height },
          candidate: null
        };
        host.root.setPointerCapture(e.pointerId);
        host.root.setAttribute("data-marquee", "");
        moveMarquee(e);
      } else if (e.altKey && !marquee) {
        e.preventDefault();
        e.stopPropagation();
        dragZoom = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY };
        host.root.setPointerCapture(e.pointerId);
        host.root.setAttribute("data-drag-zoom", "");
        zoom(1, e.clientX, e.clientY);
      }
    },
    { capture: true }
  );
  host.lifetime.listen(
    host.root,
    "pointermove",
    (e) => {
      if (marquee) moveMarquee(e);
      else if (dragZoom && e.pointerId === dragZoom.pointerId) {
        e.preventDefault();
        e.stopPropagation();
        zoom(Math.exp((e.clientY - dragZoom.lastY) * 6e-3), dragZoom.x, dragZoom.y);
        dragZoom.lastY = e.clientY;
      }
    },
    { capture: true }
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    host.lifetime.listen(
      host.root,
      type,
      (e) => {
        if (marquee?.pointerId === e.pointerId) {
          e.stopPropagation();
          if (type === "pointerup") moveMarquee(e);
          finishMarquee(type === "pointerup");
        } else if (dragZoom?.pointerId === e.pointerId) {
          e.stopPropagation();
          finishDragZoom();
        }
      },
      { capture: true }
    );
  for (const type of ["click", "dblclick"])
    host.lifetime.listen(
      host.root,
      type,
      (e) => {
        if (free() && e.altKey || performance.now() < suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true }
    );
  const pointers = /* @__PURE__ */ new Map();
  let lastPinch = null;
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  host.lifetime.listen(host.root, "pointerdown", (e) => {
    if (!free() || host.busy() || e.pointerType !== "touch") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) lastPinch = pinchState();
  });
  host.lifetime.listen(host.root, "pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && lastPinch) {
      const p = pinchState();
      zoom(lastPinch.distance / Math.max(1, p.distance), p.x, p.y, p.x - lastPinch.x, p.y - lastPinch.y);
      lastPinch = p;
    }
  });
  for (const type of ["pointerup", "pointercancel"])
    host.lifetime.listen(host.root, type, (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2 && lastPinch) {
        lastPinch = null;
        finishGesture();
      }
    });
  let safariScale = 1;
  host.lifetime.listen(host.root, "gesturestart", (e) => {
    if (!free()) return;
    e.preventDefault();
    safariScale = 1;
  });
  host.lifetime.listen(host.root, "gesturechange", (e) => {
    if (!free()) return;
    e.preventDefault();
    const g = e;
    zoom(safariScale / g.scale, g.clientX, g.clientY);
    safariScale = g.scale;
  });
  host.lifetime.listen(host.root, "gestureend", (e) => {
    if (!free()) return;
    e.preventDefault();
    finishGesture();
  });
  function serialize() {
    return {
      ...framed ? { frame: [...framedLeaves] } : {},
      ...framings.length ? { framings } : {}
    };
  }
  function restore(nav) {
    framings = nav?.framings ?? [];
    const leaves = nav?.frame ?? [];
    const destination = leaves.length ? savedFrameDestination(host.doc().root, leaves) : null;
    visits = [{ id: rootId(), leaves: leafIds(host.doc().root) }];
    visitIndex = 0;
    session = null;
    overviewReturn = null;
    framed = null;
    framedLeaves = [];
    if (destination && on()) focus(destination);
    else retarget();
  }
  return {
    sync,
    focus,
    toggle,
    stepOut,
    stepIn,
    back: () => historyGo(-1),
    forward: () => historyGo(1),
    overview: () => {
      if (framed) overviewReturn = [...framedLeaves];
      focus(null);
    },
    toggleOverview,
    frame,
    ensureVisible,
    /** Widen the framing to include these nodes (after a move). */
    include(ids) {
      if (!framed) return;
      focus(frameLeaves(host.doc().root, [...framedLeaves.filter((id) => entries.has(id)), ...ids]));
    },
    serialize,
    restore,
    cancelGestures() {
      finishMarquee(false);
      finishDragZoom();
      endGesture();
    },
    get entries() {
      return entries;
    },
    get framed() {
      return framed;
    },
    get framedNode() {
      return framed ? entries.get(framed)?.node ?? null : null;
    },
    get gesture() {
      return gesture;
    },
    get canGoBack() {
      return visitIndex > 0;
    },
    get canGoForward() {
      return visitIndex < visits.length - 1;
    },
    get suppressClicks() {
      return performance.now() < suppressClickUntil;
    },
    framings: {
      save(name) {
        if (!name.trim()) return null;
        const framing = {
          id: uid("framing"),
          name: name.trim(),
          frame: framed ? [...framedLeaves] : leafIds(host.doc().root)
        };
        framings = [...framings, framing];
        host.changed();
        return framing;
      },
      go(id) {
        const framing = framings.find((f) => f.id === id);
        if (!framing) return;
        focus(savedFrameDestination(host.doc().root, framing.frame));
      },
      remove(id) {
        framings = framings.filter((f) => f.id !== id);
        host.changed();
      },
      list: () => framings
    }
  };
}

// src/runtime/keymap.ts
var DEFAULT_KEYMAP = {
  "frame.toggle": "Mod+Shift+Enter",
  "navigation.back": "Mod+Alt+ArrowLeft",
  "navigation.forward": "Mod+Alt+ArrowRight",
  "navigation.overview": "Mod+Alt+ArrowUp",
  "panel.next": "F6",
  "panel.previous": "Shift+F6",
  "tab.next": "Mod+Alt+]",
  "tab.previous": "Mod+Alt+[",
  "view.close": "Mod+Alt+W",
  "panel.float": null,
  "panel.hide": null
};
var isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
var CODES = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  "\\": "Backslash"
};
function parseCombo(combo) {
  const parts = combo.split("+").map((p) => p.trim());
  let key = parts.pop() || "+";
  if (key === "" && parts.length) key = "+";
  const has = (name) => parts.some((p) => p.toLowerCase() === name.toLowerCase());
  const result = {
    key,
    mod: has("Mod"),
    ctrl: has("Ctrl") || has("Control"),
    meta: has("Meta") || has("Cmd"),
    alt: has("Alt") || has("Option"),
    shift: has("Shift")
  };
  if (/^[a-z0-9]$/i.test(key)) result.code = /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
  else if (CODES[key]) result.code = CODES[key];
  return result;
}
function matches(event, combo) {
  const c = parseCombo(combo);
  const mac = isMac();
  const wantCtrl = c.ctrl || c.mod && !mac;
  const wantMeta = c.meta || c.mod && mac;
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false;
  if (event.altKey !== c.alt || event.shiftKey !== c.shift) return false;
  if (c.code) return event.code === c.code;
  return event.key.toLowerCase() === c.key.toLowerCase();
}
function formatCombo(combo) {
  const c = parseCombo(combo);
  const mac = isMac();
  const arrows = {
    ArrowLeft: "\u2190",
    ArrowRight: "\u2192",
    ArrowUp: "\u2191",
    ArrowDown: "\u2193",
    Enter: mac ? "\u21A9" : "Enter"
  };
  const key = arrows[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (mac)
    return `${c.ctrl ? "\u2303" : ""}${c.alt ? "\u2325" : ""}${c.shift ? "\u21E7" : ""}${c.mod || c.meta ? "\u2318" : ""}${key}`;
  return [
    c.mod || c.ctrl ? "Ctrl" : "",
    c.meta ? "Meta" : "",
    c.alt ? "Alt" : "",
    c.shift ? "Shift" : "",
    key
  ].filter(Boolean).join("+");
}

// src/runtime/lifetime.ts
var Lifetime = class {
  controller = new AbortController();
  frames = /* @__PURE__ */ new Set();
  timers = /* @__PURE__ */ new Set();
  cleanups = [];
  get signal() {
    return this.controller.signal;
  }
  get disposed() {
    return this.controller.signal.aborted;
  }
  listen(target, type, handler, options = {}) {
    target.addEventListener(type, handler, { ...options, signal: this.signal });
  }
  frame(callback) {
    if (this.disposed) return 0;
    const id = requestAnimationFrame((time) => {
      this.frames.delete(id);
      callback(time);
    });
    this.frames.add(id);
    return id;
  }
  cancelFrame(id) {
    if (!id) return;
    cancelAnimationFrame(id);
    this.frames.delete(id);
  }
  timeout(callback, ms) {
    if (this.disposed) return void 0;
    const id = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.add(id);
    return id;
  }
  clearTimeout(id) {
    if (id === void 0) return;
    clearTimeout(id);
    this.timers.delete(id);
  }
  add(cleanup) {
    this.cleanups.push(cleanup);
  }
  dispose() {
    if (this.disposed) return;
    this.controller.abort();
    for (const id of this.frames) cancelAnimationFrame(id);
    for (const id of this.timers) clearTimeout(id);
    this.frames.clear();
    this.timers.clear();
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error(error);
      }
    }
  }
};
var Emitter = class {
  handlers = /* @__PURE__ */ new Map();
  on(event, handler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, set = /* @__PURE__ */ new Set());
    set.add(handler);
    return () => set.delete(handler);
  }
  emit(event, ...args) {
    const set = this.handlers.get(event);
    if (!set) return void 0;
    let result;
    for (const handler of [...set]) {
      try {
        const value = handler(...args);
        if (value !== void 0) result = value;
      } catch (error) {
        console.error(error);
      }
    }
    return result;
  }
  has(event) {
    return !!this.handlers.get(event)?.size;
  }
  clear() {
    this.handlers.clear();
  }
};

// src/runtime/menu.ts
function tidyMenu(entries) {
  const out = [];
  for (const entry of entries) {
    if (entry === "separator" && (!out.length || out[out.length - 1] === "separator")) continue;
    out.push(entry);
  }
  while (out[out.length - 1] === "separator") out.pop();
  return out;
}
var Menu = class _Menu {
  constructor(host, onClose = () => {
  }) {
    this.host = host;
    this.onClose = onClose;
  }
  host;
  onClose;
  el = null;
  submenu = null;
  restoreFocus = null;
  get open() {
    return !!this.el;
  }
  show(entries, anchor, focusFirst = true) {
    this.close(false);
    this.restoreFocus = document.activeElement;
    const el = h("div", { class: "trellis-menu", role: "menu", "data-trellis-part": "menu" });
    entries = tidyMenu(entries);
    for (const entry of entries) {
      if (entry === "separator") {
        el.append(h("div", { class: "trellis-menu-separator", role: "separator" }));
        continue;
      }
      el.append(this.item(entry));
    }
    this.host.append(el);
    this.el = el;
    const bounds = this.host.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let x = anchor.alignRight ? anchor.x - width : anchor.x;
    let y = anchor.y;
    x = Math.max(4, Math.min(bounds.width - width - 4, x));
    if (y + height > bounds.height - 4) y = Math.max(4, bounds.height - height - 4);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.addEventListener("keydown", (e) => this.keydown(e));
    const outside = (e) => {
      if (!this.el) return document.removeEventListener("pointerdown", outside, true);
      if (!(e.target instanceof Node) || !this.contains(e.target)) this.close();
    };
    document.addEventListener("pointerdown", outside, true);
    const cleanup = () => document.removeEventListener("pointerdown", outside, true);
    el.__cleanup = cleanup;
    if (focusFirst) this.items()[0]?.focus();
    else el.focus();
  }
  contains(node) {
    return !!this.el?.contains(node) || !!this.submenu?.contains(node);
  }
  items() {
    return [
      ...this.el?.querySelectorAll(
        ":scope > [role=menuitem]:not([aria-disabled=true]), :scope > [role=menuitemcheckbox]:not([aria-disabled=true])"
      ) ?? []
    ];
  }
  item(entry) {
    const role = entry.checked !== void 0 ? "menuitemcheckbox" : "menuitem";
    const button = h("button", {
      class: `trellis-menu-item${entry.danger ? " trellis-danger" : ""}`,
      role,
      tabindex: "-1",
      "aria-disabled": entry.disabled ? "true" : void 0,
      "aria-checked": entry.checked === void 0 ? void 0 : String(entry.checked),
      "aria-haspopup": entry.items ? "menu" : void 0
    });
    const check = h("span", { class: "trellis-menu-check" });
    if (entry.checked) check.innerHTML = icons.check;
    button.append(check, h("span", { class: "trellis-menu-label" }, entry.label));
    if (entry.shortcut) button.append(h("span", { class: "trellis-menu-shortcut" }, entry.shortcut));
    if (entry.items) {
      const chevron = h("span", { class: "trellis-menu-chevron" });
      chevron.innerHTML = icons.chevron;
      button.append(chevron);
    }
    const openSub = () => {
      if (!entry.items || entry.disabled) return;
      this.submenu?.close(false);
      this.submenu = new _Menu(this.host);
      const r = button.getBoundingClientRect();
      const b = this.host.getBoundingClientRect();
      this.submenu.show(entry.items, { x: r.right - b.left - 4, y: r.top - b.top - 5 });
      this.submenu.parent = this;
    };
    button.addEventListener("pointerenter", () => {
      if (entry.items) openSub();
      else if (this.submenu) {
        this.submenu.close(false);
        this.submenu = null;
      }
    });
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (entry.disabled) return;
      if (entry.items) return openSub();
      this.root().close();
      entry.run?.();
    });
    return button;
  }
  parent = null;
  root() {
    let menu = this;
    while (menu.parent) menu = menu.parent;
    return menu;
  }
  keydown(e) {
    const items = this.items();
    const index = items.indexOf(document.activeElement);
    const move = (to) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(items.length - 1);
      case "ArrowRight":
        if (items[index]?.getAttribute("aria-haspopup")) {
          e.preventDefault();
          items[index].click();
        }
        return;
      case "ArrowLeft":
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (this.parent) {
          const parent = this.parent;
          this.close(false);
          parent.submenu = null;
          parent.el?.querySelector("[aria-haspopup]")?.focus();
        } else this.close();
        return;
      case "Tab":
        e.preventDefault();
        this.root().close();
        return;
    }
  }
  close(restore = true) {
    this.submenu?.close(false);
    this.submenu = null;
    if (!this.el) return;
    this.el.__cleanup?.();
    this.el.remove();
    this.el = null;
    if (restore && this.restoreFocus?.isConnected) this.restoreFocus.focus();
    if (!this.parent) this.onClose();
  }
};

// src/runtime/view.ts
var ViewController = class {
  constructor(id, type, host, initial) {
    this.id = id;
    this.type = type;
    this.host = host;
    this.state = initial;
  }
  id;
  type;
  host;
  events = new Emitter();
  guards = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Set();
  state;
  get params() {
    return this.state.params;
  }
  get workspace() {
    return this.host.workspace;
  }
  get panelId() {
    return this.state.panelId;
  }
  get visible() {
    return this.state.visible;
  }
  get focused() {
    return this.state.focused;
  }
  get selected() {
    return this.state.selected;
  }
  get placement() {
    return this.state.placement;
  }
  get interactive() {
    return this.state.interactive;
  }
  get size() {
    return this.state.size;
  }
  get scale() {
    return this.state.scale;
  }
  get title() {
    return this.state.title;
  }
  get badge() {
    return this.state.badge;
  }
  setTitle(title) {
    this.host.setTitle(this.id, title);
  }
  setParams(patch) {
    this.host.setParams(this.id, patch);
  }
  get element() {
    return this.host.element(this.id);
  }
  setBadge(badge) {
    this.host.setBadge(this.id, badge);
  }
  focus() {
    this.host.focus(this.id);
  }
  close(options) {
    return this.host.close(this.id, options);
  }
  hide() {
    this.host.hide(this.id);
  }
  guardClose(guard) {
    this.guards.add(guard);
    return () => this.guards.delete(guard);
  }
  on(event, handler) {
    return this.events.on(event, handler);
  }
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;
  /** Apply new presentation state; notify only what changed. */
  update(patch) {
    const prev = this.state;
    let changed = false;
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      const old = prev[key];
      if (key === "size") {
        const a = old;
        const b = value;
        if (a.width === b.width && a.height === b.height) continue;
      } else if (old === value) continue;
      changed = true;
      break;
    }
    if (!changed) return;
    const next = { ...prev, ...patch };
    this.state = next;
    if (next.size.width !== prev.size.width || next.size.height !== prev.size.height)
      this.events.emit("resize", next.size);
    if (next.visible !== prev.visible) this.events.emit("visibility", next.visible);
    if (next.focused !== prev.focused) this.events.emit("focus", next.focused);
    if (next.interactive !== prev.interactive) this.events.emit("interactive", next.interactive);
    if (next.scale !== prev.scale) this.events.emit("scale", next.scale);
    this.events.emit("change", next);
    for (const listener of [...this.listeners]) listener();
  }
  /** Run close guards. Any false vetoes. */
  async canClose() {
    for (const guard of [...this.guards]) {
      try {
        if (await guard() === false) return false;
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    return true;
  }
  dispose() {
    this.events.clear();
    this.listeners.clear();
    this.guards.clear();
  }
};

// src/runtime/workspace.ts
var TYPE_PLACEHOLDER = (type) => ({
  title: type,
  mount(el) {
    el.append(
      h(
        "div",
        { class: "trellis-placeholder" },
        h("strong", {}, "Unavailable"),
        h("span", {}, `No view type named \u201C${type}\u201D is registered.`)
      )
    );
  }
});
var escapeHtml = (text) => text.replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
);
var DEFAULT_FLOAT_SIZE = { w: 560, h: 400 };
var FRAME_ONLY = { w: 160, h: 64 };
function createWorkspace(host, initialOptions) {
  let options = { ...initialOptions };
  const lifetime = new Lifetime();
  const events = new Emitter();
  const listeners = /* @__PURE__ */ new Set();
  const root = h("div", {
    class: "trellis",
    "data-trellis-root": "",
    role: "region",
    "aria-label": options.label ?? "Workspace",
    tabindex: "-1"
  });
  const backdrop = h("div", { "data-trellis-part": "backdrop" });
  const stageEmpty = h("div", { "data-trellis-part": "stage-empty" });
  const empty = h("div", { "data-trellis-part": "empty" });
  const layer = h("div", { class: "trellis-layer" });
  const dividers = h("div", { class: "trellis-dividers" });
  const sourceSlot = h("div", { "data-trellis-part": "source-slot", "aria-hidden": "true" });
  const dropLabel = h("span", { "data-trellis-part": "drop-label" });
  const dropSlot = h("div", { "data-trellis-part": "drop-slot", "aria-hidden": "true" }, dropLabel);
  const chrome = h("div", { "data-trellis-part": "chrome" });
  const live = h("div", { class: "trellis-sr", "aria-live": "polite" });
  root.append(backdrop, stageEmpty, empty, layer, dividers, sourceSlot, dropSlot, chrome, live);
  host.append(root);
  lifetime.add(() => root.remove());
  const slots = { backdrop, stageEmpty, empty, chrome };
  let menuCloseHook = null;
  const menu = new Menu(root, () => {
    menuCloseHook?.();
    menuCloseHook = null;
  });
  lifetime.add(() => menu.close(false));
  let doc = emptyDocument();
  let entries = /* @__PURE__ */ new Map();
  let focusedPanel = null;
  let focusedView = null;
  let lastStagePanel = null;
  const badges = /* @__PURE__ */ new Map();
  const panelDoms = /* @__PURE__ */ new Map();
  const records = /* @__PURE__ */ new Map();
  const dividerEls = /* @__PURE__ */ new Map();
  const lastRects = /* @__PURE__ */ new Map();
  const leaving = /* @__PURE__ */ new Map();
  const entering = /* @__PURE__ */ new Map();
  const settling = /* @__PURE__ */ new Set();
  let surfacesList = [];
  let viewport = { w: host.clientWidth, h: host.clientHeight };
  let gap = 6;
  let tabbarHeight = 34;
  const tween = new LayoutTween();
  const camera = new RectSpring(UNIT);
  let nav;
  let dragger;
  const lifted = () => dragger?.session?.active ? dragger.session.lifted : null;
  const dragActive = () => !!dragger?.active;
  let gesture = false;
  let frame = 0;
  let lastTime = 0;
  let snapshot = null;
  let persistTimer;
  let openCounter = 0;
  const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const reduced = () => options.motion === "reduced" || options.motion !== "full" && !!reducedQuery?.matches;
  const floatingLayer = () => options.floating === void 0 ? "overlay" : options.floating;
  const navigationMode = () => options.navigation === void 0 ? "focus" : options.navigation;
  const placeholders = /* @__PURE__ */ new Map();
  function typeOf(viewId) {
    const type = doc.views[viewId]?.type ?? "unknown";
    const def = options.types[type];
    if (def) return def;
    let placeholder = placeholders.get(type);
    if (!placeholder) placeholders.set(type, placeholder = TYPE_PLACEHOLDER(type));
    return placeholder;
  }
  function titleOf(viewId) {
    const record = doc.views[viewId];
    if (!record) return "";
    if (record.title) return record.title;
    const def = options.types[record.type];
    const title = def?.title;
    if (typeof title === "function") {
      const controller = records.get(viewId)?.controller;
      if (controller)
        try {
          return title(controller);
        } catch (error) {
          console.error(error);
        }
    } else if (title) return title;
    return record.type;
  }
  let appliedTokens = /* @__PURE__ */ new Set();
  function applyTheme() {
    setAttr(root, "data-theme", options.theme ?? "system");
    const tabs = options.tabs ?? {};
    setAttr(root, "data-tab-fill", tabs.fill ? "" : null);
    setAttr(root, "data-tab-bleed", tabs.inset === 0 ? "" : null);
    if (tabs.inset !== void 0) root.style.setProperty("--trellis-tab-inset", `${tabs.inset}px`);
    else if (!options.tokens?.["--trellis-tab-inset"]) root.style.removeProperty("--trellis-tab-inset");
    setAttr(root, "aria-label", options.label ?? "Workspace");
    const tokens = options.tokens ?? {};
    for (const key of appliedTokens) if (!(key in tokens)) root.style.removeProperty(key);
    for (const [key, value] of Object.entries(tokens))
      if (value === "" || value == null) root.style.removeProperty(key);
      else root.style.setProperty(key, value);
    appliedTokens = new Set(Object.keys(tokens));
    setAttr(root, "data-navigation", String(navigationMode()));
    readMetrics();
  }
  function readMetrics() {
    const style = getComputedStyle(root);
    const g = parseFloat(style.getPropertyValue("--trellis-gap"));
    const t = parseFloat(style.getPropertyValue("--trellis-tabbar-height"));
    if (Number.isFinite(g)) gap = g;
    if (Number.isFinite(t)) tabbarHeight = t;
  }
  const pad = () => gap / 2;
  function toScreen(r) {
    const c = camera.value;
    const p = pad();
    const W = viewport.w - p * 2;
    const H = viewport.h - p * 2;
    return {
      x: p + (r.x - c.x) / c.w * W,
      y: p + (r.y - c.y) / c.h * H,
      w: r.w / c.w * W,
      h: r.h / c.h * H
    };
  }
  function fromScreen(p) {
    const c = camera.value;
    const q = pad();
    return {
      x: c.x + (p.x - q) / (viewport.w - q * 2) * c.w,
      y: c.y + (p.y - q) / (viewport.h - q * 2) * c.h
    };
  }
  const inset = (r, d) => ({
    x: r.x + d,
    y: r.y + d,
    w: Math.max(0, r.w - d * 2),
    h: Math.max(0, r.h - d * 2)
  });
  function stageWorld() {
    const stage = findStage(doc.root);
    return stage && entries.get(stage.id)?.rect || UNIT;
  }
  function stageScreen() {
    const stage = findStage(doc.root);
    if (!stage) return null;
    const e = entries.get(stage.id);
    return e ? inset(toScreen(e.rect), pad()) : null;
  }
  function floatContainer(layerName) {
    if (layerName === "overlay") return { x: 0, y: 0, w: viewport.w, h: viewport.h };
    return toScreen(stageWorld());
  }
  function floatScreen(rect, layerName) {
    const c = floatContainer(layerName);
    return { x: c.x + rect.x * c.w, y: c.y + rect.y * c.h, w: rect.w * c.w, h: rect.h * c.h };
  }
  function screenToFloat(r, layerName) {
    const c = floatContainer(layerName);
    return { x: (r.x - c.x) / c.w, y: (r.y - c.y) / c.h, w: r.w / c.w, h: r.h / c.h };
  }
  function targetRect(panelId) {
    if (lifted()?.id === panelId) return dragger.liftedRect();
    const preview = dragger?.layoutTargets()?.get(panelId);
    if (preview && !doc.floating.some((f) => f.panel.id === panelId)) return inset(toScreen(preview), pad());
    const float2 = doc.floating.find((f) => f.panel.id === panelId);
    if (float2) return floatScreen(float2.rect, float2.layer);
    const e = entries.get(panelId);
    return e ? inset(toScreen(e.rect), pad()) : null;
  }
  function regionOf(panelId) {
    if (doc.floating.some((f) => f.panel.id === panelId)) return "floating";
    const stage = findStage(doc.root);
    if (stage && findNode(stage, panelId)) return "stage";
    return "side";
  }
  function viewState(viewId) {
    return {
      visible: false,
      focused: false,
      selected: false,
      placement: "docked",
      interactive: true,
      size: { width: 0, height: 0 },
      scale: 1,
      title: titleOf(viewId),
      badge: badges.get(viewId) ?? null,
      panelId: panelOfView(doc, viewId)?.id ?? "",
      params: doc.views[viewId]?.params ?? {}
    };
  }
  const viewHost = {
    get workspace() {
      return handle;
    },
    params: (id) => doc.views[id]?.params ?? {},
    setTitle: (id, title) => setTitle(id, title),
    setParams: (id, patch) => setParams(id, patch),
    element: (id) => records.get(id).content,
    setBadge: (id, badge) => {
      badges.set(id, badge);
      records.get(id)?.controller.update({ badge });
      updateTabs();
    },
    focus: (id) => handle.focus(id),
    close: (id, o) => close(id, o),
    hide: (id) => hide(id)
  };
  function ensureSurface(viewId) {
    let record = records.get(viewId);
    if (record) return record;
    const type = doc.views[viewId].type;
    const shell = h("div", {
      "data-trellis-part": "surface",
      "data-view": viewId,
      "data-type": type,
      role: "tabpanel",
      id: `${uidBase}-surface-${cssId(viewId)}`
    });
    const content = h("div", { "data-trellis-part": "content", "data-trellis-content": viewId });
    shell.append(content);
    const icon = h("span", { "data-trellis-part": "tab-icon" });
    const accessory = h("div", { "data-trellis-part": "accessory", "data-view": viewId });
    layer.append(shell);
    const controller = new ViewController(viewId, type, viewHost, viewState(viewId));
    record = {
      controller,
      shell,
      content,
      icon,
      accessory,
      cleanup: null,
      mountedWith: null,
      mountKey: null,
      iconHtml: null,
      surface: { view: controller, content, icon, accessory }
    };
    records.set(viewId, record);
    controller.update({ title: titleOf(viewId) });
    lifetime.listen(shell, "pointerdown", () => focusView(viewId, false), { capture: true });
    lifetime.listen(shell, "focusin", () => focusView(viewId, false));
    mountContent(record);
    return record;
  }
  function mountContent(record) {
    const def = typeOf(record.controller.id);
    record.mountedWith = def;
    setAttr(record.shell, "class", def.className ?? null);
    const raw = def.iframe ? typeof def.iframe === "function" ? def.iframe(record.controller) : def.iframe : null;
    const frame2 = raw === null ? null : typeof raw === "string" ? { src: raw } : raw;
    const key = frame2 ? `iframe:${JSON.stringify(frame2)}` : def.mount ?? null;
    if (key !== record.mountKey) {
      if (record.mountKey !== null) {
        try {
          record.cleanup?.();
        } catch (error) {
          console.error(error);
        }
        record.cleanup = null;
        record.content.replaceChildren();
      }
      record.mountKey = key;
      if (frame2) {
        const frameEl = h("iframe", {
          src: frame2.src,
          srcdoc: frame2.srcdoc,
          sandbox: frame2.sandbox,
          allow: frame2.allow,
          referrerpolicy: frame2.referrerPolicy,
          title: frame2.title ?? titleOf(record.controller.id),
          "data-trellis-iframe": ""
        });
        record.content.append(frameEl);
        record.cleanup = () => frameEl.remove();
      } else if (def.mount) {
        try {
          const cleanup = def.mount(record.content, record.controller, {
            icon: record.icon,
            accessory: record.accessory
          });
          record.cleanup = typeof cleanup === "function" ? cleanup : null;
        } catch (error) {
          console.error(error);
        }
      }
    }
    const icon = def.icon ?? null;
    if (icon !== record.iconHtml) {
      if (icon !== null || record.iconHtml !== null) record.icon.innerHTML = icon ?? "";
      record.iconHtml = icon;
    }
  }
  function destroySurface(viewId) {
    const record = records.get(viewId);
    if (!record) return;
    try {
      record.cleanup?.();
    } catch (error) {
      console.error(error);
    }
    record.shell.remove();
    record.icon.remove();
    record.accessory.remove();
    record.controller.dispose();
    records.delete(viewId);
    badges.delete(viewId);
  }
  const uidBase = uid("trellis");
  const cssId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  function ensurePanelDom(panelId) {
    let dom = panelDoms.get(panelId);
    if (dom) return dom;
    const el = h("div", { "data-trellis-part": "panel", "data-panel": panelId });
    const tablist = h("div", {
      "data-trellis-part": "tabs",
      role: "tablist",
      "aria-orientation": "horizontal"
    });
    const accessories = h("div", { "data-trellis-part": "accessories" });
    const menuButton = h("button", {
      "data-trellis-part": "panel-menu",
      type: "button",
      "aria-label": "Panel menu",
      "aria-haspopup": "menu",
      tabindex: "-1"
    });
    menuButton.innerHTML = icons.more;
    const tabbar = h(
      "div",
      { "data-trellis-part": "tabbar", "data-panel": panelId },
      tablist,
      accessories,
      menuButton
    );
    el.append(tabbar);
    layer.append(el);
    const frameIcon = h("span", { "data-trellis-part": "frame-icon", "aria-hidden": "true" });
    el.append(frameIcon);
    dom = {
      id: panelId,
      el,
      tabbar,
      tablist,
      accessories,
      menuButton,
      tabs: /* @__PURE__ */ new Map(),
      handles: null,
      frameIcon,
      endInset: 0
    };
    panelDoms.set(panelId, dom);
    const d = dom;
    const onPointerDown = (e) => {
      const panel = findPanel(d.id);
      if (panel) focusView(panel.selected, false);
      if (doc.floating.some((f) => f.panel.id === d.id)) {
        const raised = raiseFloat(doc, d.id);
        if (raised !== doc) commit(raised, { animate: false, silent: true });
      }
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest("button, [data-trellis-part=accessory], [data-trellis-part=resize]")) {
        if (!target.closest("[data-trellis-part=tab]")) return;
      }
      const tab = target.closest("[data-trellis-part=tab]");
      if (tab && target.closest("[data-trellis-part=tab-close]")) return;
      if (!panel) return;
      if (tab) dragger.begin(e, panel, tab.dataset.view);
      else if (target.closest("[data-trellis-part=tabbar]") || d.el.hasAttribute("data-frame-only"))
        dragger.begin(e, panel, null);
    };
    lifetime.listen(el, "pointerdown", onPointerDown);
    lifetime.listen(tabbar, "pointerdown", (e) => {
      if (tabbar.parentElement !== el) onPointerDown(e);
    });
    lifetime.listen(tabbar, "dblclick", (e) => {
      const target = e.target;
      if (target.closest("button:not([data-trellis-part=tab]), [data-trellis-part=accessory]")) return;
      if (navigationMode()) toggleFrame(d.id);
    });
    lifetime.listen(menuButton, "click", (e) => {
      e.stopPropagation();
      openPanelMenu(d.id, menuButton);
    });
    lifetime.listen(tabbar, "contextmenu", (e) => {
      const target = e.target;
      if (target.closest("[data-trellis-part=accessory]")) return;
      e.preventDefault();
      const tab = target.closest("[data-trellis-part=tab]");
      if (tab) selectAndFocus(tab.dataset.view);
      const b = root.getBoundingClientRect();
      openPanelMenu(d.id, null, { x: e.clientX - b.left, y: e.clientY - b.top });
    });
    lifetime.listen(tablist, "keydown", (e) => tabKeydown(e, d.id));
    lifetime.listen(
      tablist,
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey || tablist.scrollWidth <= tablist.clientWidth) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          tablist.scrollLeft += e.deltaY;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { passive: false }
    );
    return dom;
  }
  function destroyPanelDom(panelId) {
    const dom = panelDoms.get(panelId);
    if (!dom) return;
    dom.el.remove();
    dom.tabbar.remove();
    dom.handles?.remove();
    panelDoms.delete(panelId);
    lastRects.delete(panelId);
  }
  function barMode(panel) {
    if (!panel) return "normal";
    const modes = panel.views.map((v) => typeOf(v).tabbar ?? "always");
    if (modes.every((m) => m === "never")) return "hidden";
    if (panel.views.length === 1 && modes[0] === "auto")
      return lifted()?.id === panel.id ? "normal" : "hidden";
    if (panel.views.length === 1 && modes[0] === "overlay") return "overlay";
    return "normal";
  }
  function barHeight(panel) {
    return barMode(panel) === "normal" ? tabbarHeight : 0;
  }
  function findPanel(panelId) {
    if (lifted()?.id === panelId) return lifted();
    return locatePanel(doc, panelId)?.panel ?? leaving.get(panelId)?.panel ?? null;
  }
  function syncTabs(panel) {
    const dom = ensurePanelDom(panel.id);
    const wanted = new Set(panel.views);
    for (const [viewId, tab] of dom.tabs)
      if (!wanted.has(viewId)) {
        tab.el.remove();
        dom.tabs.delete(viewId);
      }
    panel.views.forEach((viewId, index) => {
      let tab = dom.tabs.get(viewId);
      const record = ensureSurface(viewId);
      if (!tab) {
        const title = h("span", { "data-trellis-part": "tab-title" });
        const badge = h("span", { "data-trellis-part": "tab-badge" });
        const closeButton = h("span", { "data-trellis-part": "tab-close", "aria-hidden": "true" });
        closeButton.innerHTML = icons.close;
        const el = h("div", {
          "data-trellis-part": "tab",
          "data-view": viewId,
          role: "tab",
          id: `${uidBase}-tab-${cssId(viewId)}`,
          "aria-controls": record.shell.id
        });
        el.append(record.icon, title, badge, closeButton);
        lifetime.listen(closeButton, "click", (e) => {
          e.stopPropagation();
          void close(viewId);
        });
        lifetime.listen(el, "click", (e) => {
          if (e.target.closest("[data-trellis-part=tab-close]")) return;
          selectAndFocus(viewId);
        });
        lifetime.listen(el, "auxclick", (e) => {
          if (e.button === 1 && typeOf(viewId).closable !== false) void close(viewId);
        });
        tab = { el, title, badge, close: closeButton };
        dom.tabs.set(viewId, tab);
      } else if (tab.el.firstChild !== record.icon) tab.el.prepend(record.icon);
      if (dom.tablist.children[index] !== tab.el)
        dom.tablist.insertBefore(tab.el, dom.tablist.children[index] ?? null);
      if (record.accessory.parentElement !== dom.accessories) dom.accessories.append(record.accessory);
      setAttr(record.shell, "aria-labelledby", tab.el.id);
    });
  }
  function revealTab(list, tab) {
    if (list.scrollWidth <= list.clientWidth) return;
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth)
      list.scrollLeft = left + tab.offsetWidth - list.clientWidth + 8;
  }
  function updateTabs() {
    for (const [panelId, dom] of panelDoms) {
      const panel = findPanel(panelId);
      if (!panel) continue;
      for (const [viewId, tab] of dom.tabs) {
        const selected = panel.selected === viewId;
        const title = titleOf(viewId);
        if (tab.title.textContent !== title) tab.title.textContent = title;
        const badge = badges.get(viewId);
        const dot = badge === true;
        const text = badge === null || badge === void 0 || badge === "" || typeof badge === "boolean" ? "" : String(badge);
        if (tab.badge.textContent !== text) tab.badge.textContent = text;
        setAttr(tab.badge, "hidden", text || dot ? null : "");
        setAttr(tab.badge, "data-dot", dot ? "" : null);
        setAttr(tab.el, "data-badge", dot ? "dot" : text ? "" : null);
        setAttr(tab.el, "data-type", doc.views[viewId]?.type ?? null);
        setAttr(tab.el, "aria-selected", String(selected));
        setAttr(tab.el, "tabindex", selected ? "0" : "-1");
        if (selected && !tab.el.hasAttribute("data-selected")) revealTab(dom.tablist, tab.el);
        setAttr(tab.el, "data-selected", selected ? "" : null);
        setAttr(tab.el, "data-focused", focusedView === viewId ? "" : null);
        const closable = typeOf(viewId).closable !== false;
        setAttr(tab.close, "hidden", closable ? null : "");
        setAttr(tab.close, "title", `Close ${title}`);
        setAttr(tab.el, "aria-keyshortcuts", closable ? "Delete Shift+F10" : "Shift+F10");
        const record = records.get(viewId);
        if (record) {
          setAttr(record.accessory, "hidden", selected ? null : "");
          if (record.controller.state.title !== title) record.controller.update({ title });
        }
      }
      setAttr(dom.el, "data-focused", focusedPanel === panelId ? "" : null);
      setAttr(dom.el, "data-single", panel.views.length === 1 ? "" : null);
      setAttr(dom.tabbar, "data-focused", focusedPanel === panelId ? "" : null);
      setAttr(dom.tabbar, "data-single", panel.views.length === 1 ? "" : null);
      const iconSource = records.get(panel.selected)?.icon.innerHTML ?? "";
      const icon = iconSource || `<b>${escapeHtml(titleOf(panel.selected).slice(0, 1).toUpperCase())}</b>`;
      if (dom.frameIcon.innerHTML !== icon) dom.frameIcon.innerHTML = icon;
      if (barMode(panel) === "overlay")
        dom.endInset = dom.accessories.offsetWidth + dom.menuButton.offsetWidth + 24;
      const hasMenu = options.panelMenu === true || options.panelMenu === void 0 ? true : panelMenuEntries(panel).length > 0;
      setAttr(dom.menuButton, "hidden", hasMenu ? null : "");
    }
    invalidate();
  }
  function sync() {
    entries = layoutRects(doc.root);
    const live2 = new Set(viewIds(doc));
    for (const v of lifted()?.views ?? []) live2.add(v);
    for (const l of leaving.values()) for (const v of l.panel.views) live2.add(v);
    for (const viewId of [...records.keys()]) if (!live2.has(viewId)) destroySurface(viewId);
    const panelIds = /* @__PURE__ */ new Set();
    const visiblePanels = [
      ...panelsOf(doc.root),
      ...doc.floating.map((f) => f.panel),
      ...lifted() ? [lifted()] : [],
      ...[...leaving.values()].map((l) => l.panel)
    ];
    for (const panel of visiblePanels) {
      panelIds.add(panel.id);
      syncTabs(panel);
    }
    for (const hidden of doc.hidden) for (const v of hidden.panel.views) ensureSurface(v);
    for (const id of [...panelDoms.keys()]) if (!panelIds.has(id)) destroyPanelDom(id);
    for (const record of records.values()) mountContent(record);
    for (const [id, dom] of panelDoms) {
      const floating = doc.floating.some((f) => f.panel.id === id) || lifted()?.id === id;
      setAttr(dom.el, "data-floating", floating ? "" : null);
      setAttr(dom.el, "data-region", floating ? "floating" : regionOf(id));
      if (floating && !dom.handles && lifted()?.id !== id) addResizeHandles(dom);
      if ((!floating || lifted()?.id === id) && dom.handles) {
        dom.handles.remove();
        dom.handles = null;
      }
    }
    syncDividers();
    const list = [...records.values()].map((r) => r.surface);
    if (list.length !== surfacesList.length || list.some((s, i) => s !== surfacesList[i])) {
      surfacesList = list;
      events.emit("surfaces", surfacesList);
    }
    const stage = findStage(doc.root);
    setAttr(root, "data-has-stage", stage ? "" : null);
    setAttr(root, "data-empty", !doc.root && !doc.floating.length ? "" : null);
    setAttr(root, "data-stage-empty", stage && !stage.child ? "" : null);
    updateTabs();
    nav?.sync();
    invalidate();
    schedule();
  }
  function syncDividers() {
    const wanted = /* @__PURE__ */ new Set();
    const visit = (node) => {
      if (!node) return;
      if (node.kind === "stage") return visit(node.child);
      if (node.kind !== "split") return;
      for (let i = 0; i < node.children.length - 1; i++) {
        const key = `${node.id}:${i}`;
        wanted.add(key);
        if (!dividerEls.has(key)) {
          const el2 = h("div", {
            "data-trellis-part": "divider",
            role: "separator",
            tabindex: "0",
            "aria-orientation": node.axis === "x" ? "vertical" : "horizontal",
            "aria-label": "Resize panels"
          });
          el2.dataset.split = node.id;
          el2.dataset.index = String(i);
          lifetime.listen(el2, "pointerdown", (e) => beginDivider(e, el2));
          lifetime.listen(el2, "dblclick", () => equalize(el2.dataset.split, Number(el2.dataset.index)));
          lifetime.listen(el2, "keydown", (e) => dividerKey(e, el2));
          dividers.append(el2);
          dividerEls.set(key, el2);
        }
        const el = dividerEls.get(key);
        setAttr(el, "data-axis", node.axis);
      }
      node.children.forEach(visit);
    };
    visit(doc.root);
    for (const [key, el] of dividerEls)
      if (!wanted.has(key)) {
        el.remove();
        dividerEls.delete(key);
      }
  }
  function commit(next, o = {}) {
    const previous = doc;
    if (next === previous) return;
    const animate = o.animate !== false && !reduced();
    if (animate) {
      const from = new Map(lastRects);
      if (o.from) for (const [k, v] of o.from) from.set(k, v);
      tween.begin(from, performance.now());
    }
    doc = next;
    const before = new Set(viewIds(previous));
    const after = new Set(viewIds(doc));
    sync();
    for (const id of after)
      if (!before.has(id)) {
        const info = infoOf(id);
        if (info) events.emit("open", info);
      }
    for (const id of before)
      if (!after.has(id) && !lifted()?.views.includes(id)) {
        const record = previous.views[id];
        if (record)
          events.emit("close", {
            id,
            type: record.type,
            params: record.params ?? {},
            title: record.title ?? record.type,
            panelId: "",
            placement: "docked",
            selected: false
          });
      }
    if (focusedView && !after.has(focusedView) && !lifted()?.views.includes(focusedView)) {
      const fallback = panelOfView(doc, lastFocusFallback()) ?? panelsOf(doc.root)[0] ?? doc.floating[0]?.panel ?? null;
      setFocus(fallback?.selected ?? null, false);
    } else if (focusedView) {
      const panel = panelOfView(doc, focusedView);
      focusedPanel = panel?.id ?? focusedPanel;
    }
    render();
    if (!o.silent) emitChange();
  }
  function lastFocusFallback() {
    return lastStagePanel ? locatePanel(doc, lastStagePanel)?.panel.selected ?? "" : "";
  }
  function emitChange() {
    const snapshotDoc = getDocument();
    events.emit("change", snapshotDoc);
    persist();
  }
  function getDocument() {
    return {
      ...doc,
      navigation: nav.serialize()
    };
  }
  function persist() {
    if (!options.persist) return;
    lifetime.clearTimeout(persistTimer);
    persistTimer = lifetime.timeout(() => {
      try {
        localStorage.setItem(
          options.persist.key,
          JSON.stringify({ ...getDocument(), version: options.persist.version ?? doc.version })
        );
      } catch {
      }
    }, 120);
  }
  function loadPersisted() {
    if (!options.persist) return null;
    try {
      const raw = localStorage.getItem(options.persist.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.schema !== 1) return null;
      if ((options.persist.version ?? void 0) !== (parsed.version ?? void 0)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function prepare(input) {
    const drop = /* @__PURE__ */ new Set();
    for (const [id, record] of Object.entries(input.views ?? {})) {
      if (!record || options.types[record.type]) continue;
      const decision = options.onMissingType?.(record.type, id) ?? "placeholder";
      if (decision === "drop") drop.add(id);
    }
    const doc2 = sanitize(input, () => true);
    let result = doc2;
    for (const id of drop) result = closeView(result, id);
    return result;
  }
  function defaultDocument() {
    const spec = options.defaultLayout;
    if (!spec) return emptyDocument();
    if (spec.schema === 1) return structuredClone(spec);
    return createDocument(spec);
  }
  function schedule() {
    if (frame || lifetime.disposed) return;
    frame = lifetime.frame(tick);
  }
  function tick(time) {
    frame = 0;
    const dt = lastTime ? (time - lastTime) / 1e3 : 0.016;
    lastTime = time;
    let moving2 = false;
    if (camera.moving && !gesture) {
      if (reduced()) camera.finish();
      else moving2 = camera.step(dt) || moving2;
    }
    cameraChanged();
    if (tween.active) moving2 = tween.step(time) || moving2;
    if (!tween.active) settling.clear();
    if (dragActive()) moving2 = true;
    for (const [id, l] of leaving)
      if (time - l.start >= l.duration) {
        leaving.delete(id);
        destroyPanelDom(id);
        syncSilently();
      } else moving2 = true;
    if (entering.size) moving2 = true;
    render(time);
    if (moving2) schedule();
    else {
      lastTime = 0;
      settle();
    }
  }
  function syncSilently() {
    const list = [...records.values()].map((r) => r.surface);
    surfacesList = list;
  }
  let settledState = true;
  function settle() {
    for (const record of records.values()) {
      const s = record.controller.state;
      const size = record.__size;
      if (size && (size.width !== s.size.width || size.height !== s.size.height))
        record.controller.update({ size });
      const scale = record.__scale;
      if (scale !== void 0 && scale !== s.scale) record.controller.update({ scale });
    }
    for (const [id, dom] of panelDoms)
      if (dom.tabbar.hasAttribute("data-overlay")) {
        const inset2 = dom.accessories.offsetWidth + dom.menuButton.offsetWidth + 24;
        if (inset2 !== dom.endInset) {
          dom.endInset = inset2;
          const panel = findPanel(id);
          if (panel)
            for (const v of panel.views)
              records.get(v)?.content.style.setProperty("--trellis-titlebar-inset-end", `${inset2}px`);
        }
      }
    if (!settledState) {
      settledState = true;
      updateInteractivity();
    }
  }
  function updateInteractivity() {
    const busy = !!dragActive() || gesture;
    setAttr(root, "data-busy", busy ? "" : null);
    for (const record of records.values()) {
      const scale = record.controller.state.scale;
      record.controller.update({ interactive: !busy && scale >= 0.999 });
    }
  }
  const moving = () => camera.moving || tween.active || !!dragActive() || gesture || leaving.size > 0 || entering.size > 0;
  function render(time = performance.now()) {
    if (lifetime.disposed) return;
    const round = !moving();
    if (moving()) settledState = false;
    const stage = findStage(doc.root);
    const stagePreview = stage ? dragger?.layoutTargets()?.get(stage.id) : void 0;
    const sScreen = stagePreview ? inset(toScreen(stagePreview), pad()) : stageScreen();
    if (sScreen) {
      const r = tween.apply(stage.id, sScreen);
      setStyle(root, "--trellis-stage-x", `${r.x}px`);
      setStyle(root, "--trellis-stage-y", `${r.y}px`);
      setStyle(root, "--trellis-stage-w", `${r.w}px`);
      setStyle(root, "--trellis-stage-h", `${r.h}px`);
      place(backdrop, r, round);
      place(stageEmpty, r, round);
      lastRects.set(stage.id, r);
      setStyle(backdrop, "display", "");
      setStyle(stageEmpty, "display", stage.child ? "none" : "");
    } else {
      place(backdrop, { x: 0, y: 0, w: viewport.w, h: viewport.h }, true);
      setStyle(stageEmpty, "display", "none");
    }
    setStyle(empty, "display", !doc.root && !doc.floating.length && !lifted() ? "" : "none");
    const stageFloats = doc.floating.filter((f) => f.layer === "stage").sort((a, b) => a.z - b.z);
    const overlayFloats = doc.floating.filter((f) => f.layer === "overlay").sort((a, b) => a.z - b.z);
    const zOf = /* @__PURE__ */ new Map();
    for (const p of panelsOf(doc.root)) zOf.set(p.id, settling.has(p.id) ? 2900 : 10);
    stageFloats.forEach((f, i) => zOf.set(f.panel.id, settling.has(f.panel.id) ? 2900 : 30 + i * 3));
    overlayFloats.forEach((f, i) => zOf.set(f.panel.id, settling.has(f.panel.id) ? 2900 : 1e3 + i * 3));
    if (lifted()) zOf.set(lifted().id, 3100);
    for (const id of leaving.keys()) zOf.set(id, 2950);
    const shown = /* @__PURE__ */ new Set();
    for (const [panelId, dom] of panelDoms) {
      const panel = findPanel(panelId);
      if (!panel) continue;
      let r;
      let opacity = 1;
      const l = leaving.get(panelId);
      const enter = entering.get(panelId);
      if (l) {
        const e = DOCK_EASE(Math.min(1, (time - l.start) / l.duration));
        r = lerpRect(l.from, l.to, e);
        opacity = 1 - 0.9 * e;
      } else if (enter) {
        const target = targetRect(panelId);
        if (!target) continue;
        const t = Math.min(1, (time - enter.start) / DOCK_MS.restore);
        const e = DOCK_EASE(t);
        r = lerpRect(enter.from, target, e);
        opacity = 0.1 + 0.9 * e;
        if (t >= 1) entering.delete(panelId);
      } else {
        const target = targetRect(panelId);
        if (!target) continue;
        r = lifted()?.id === panelId ? dragger.liftedRect() : tween.apply(panelId, target);
      }
      lastRects.set(panelId, r);
      const onscreen = r.x < viewport.w && r.y < viewport.h && r.x + r.w > 0 && r.y + r.h > 0 && r.w > 2 && r.h > 2;
      setStyle(dom.el, "display", onscreen ? "" : "none");
      setStyle(dom.el, "opacity", opacity === 1 ? "" : String(opacity));
      const z = zOf.get(panelId) ?? 10;
      setStyle(dom.el, "zIndex", String(z));
      setAttr(dom.el, "data-lifted", lifted()?.id === panelId ? "" : null);
      place(dom.el, r, round);
      const float2 = doc.floating.find((f) => f.panel.id === panelId);
      const clip = float2?.layer === "stage" && sScreen && lifted()?.id !== panelId ? clipInset(r, sScreen) : "";
      setStyle(dom.el, "clipPath", clip);
      const mode = barMode(panel);
      const bar = mode === "normal" ? tabbarHeight : 0;
      const frameOnly = lifted()?.id !== panelId && (r.w < FRAME_ONLY.w || r.h < FRAME_ONLY.h + (panel.views.length > 1 ? tabbarHeight : 0));
      setAttr(dom.el, "data-frame-only", frameOnly ? "" : null);
      if (frameOnly)
        setStyle(dom.el, "--trellis-frame-icon-size", `${Math.max(0, Math.min(40, r.w - 12, r.h - 12))}px`);
      setAttr(dom.el, "data-compact", r.w < 140 || r.h < bar + 24 ? "" : null);
      setAttr(dom.el, "data-tabbar", mode === "normal" ? null : mode);
      if (mode === "overlay") {
        if (dom.tabbar.parentElement !== layer) layer.append(dom.tabbar);
        setAttr(dom.tabbar, "data-overlay", "");
        setStyle(dom.tabbar, "zIndex", String(z + 2));
        setStyle(dom.tabbar, "display", onscreen ? "" : "none");
        setStyle(dom.tabbar, "opacity", opacity === 1 ? "" : String(opacity));
        setStyle(
          dom.tabbar,
          "clipPath",
          clip ? clipInset({ x: r.x, y: r.y, w: r.w, h: tabbarHeight }, sScreen) : ""
        );
        place(dom.tabbar, { x: r.x, y: r.y, w: r.w, h: tabbarHeight }, round);
      }
      if (dom.handles) {
        setStyle(dom.handles, "zIndex", String(z + 2));
        setStyle(dom.handles, "display", onscreen && !frameOnly ? "" : "none");
        setStyle(dom.handles, "opacity", opacity === 1 ? "" : String(opacity));
        setStyle(dom.handles, "clipPath", clip);
        place(dom.handles, r, round);
      }
      if (mode !== "overlay" && dom.tabbar.parentElement !== dom.el) {
        dom.el.prepend(dom.tabbar);
        setAttr(dom.tabbar, "data-overlay", null);
        for (const key of ["zIndex", "display", "opacity", "clipPath", "transform", "width", "height"])
          setStyle(dom.tabbar, key, "");
      }
      if (!onscreen) continue;
      const body = { x: r.x, y: r.y + bar, w: r.w, h: Math.max(0, r.h - bar) };
      for (const viewId of panel.views) {
        const record = records.get(viewId);
        if (!record) continue;
        shown.add(viewId);
        const selected = panel.selected === viewId;
        placeSurface(
          record,
          body,
          selected,
          z + 1,
          round,
          opacity,
          clip ? clipInset(body, sScreen) : "",
          frameOnly
        );
        setAttr(record.shell, "data-tabbar", mode === "normal" ? null : mode);
        const scale = record.__scale || 1;
        setStyle(
          record.content,
          "--trellis-titlebar-height",
          mode === "overlay" ? `${tabbarHeight / scale}px` : "0px"
        );
        setStyle(
          record.content,
          "--trellis-titlebar-inset-end",
          mode === "overlay" ? `${dom.endInset / scale}px` : "0px"
        );
      }
    }
    for (const [viewId, record] of records) {
      if (shown.has(viewId)) continue;
      setStyle(record.shell, "visibility", "hidden");
      setAttr(record.shell, "inert", "");
      const panel = panelOfView(doc, viewId);
      const hidden = panel ? doc.hidden.some((x) => x.panel.id === panel.id) : false;
      record.controller.update({
        visible: false,
        selected: panel?.selected === viewId,
        placement: hidden ? "hidden" : placementOf(viewId),
        panelId: panel?.id ?? record.controller.state.panelId,
        focused: focusedView === viewId
      });
    }
    renderDividers(round);
    renderSlots(round);
  }
  function clipInset(r, bounds) {
    const top = Math.max(0, bounds.y - r.y);
    const left = Math.max(0, bounds.x - r.x);
    const right = Math.max(0, r.x + r.w - (bounds.x + bounds.w));
    const bottom = Math.max(0, r.y + r.h - (bounds.y + bounds.h));
    if (!top && !left && !right && !bottom) return "";
    return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }
  const FREE_MIN = { width: 480, height: 320 };
  function minSizeOf(viewId) {
    return typeOf(viewId).minSize ?? (navigationMode() === "free" ? FREE_MIN : void 0);
  }
  function placementOf(viewId) {
    const panel = panelOfView(doc, viewId) ?? (lifted()?.views.includes(viewId) ? lifted() : null);
    if (!panel) return "docked";
    if (doc.hidden.some((x) => x.panel.id === panel.id)) return "hidden";
    const r = regionOf(panel.id);
    return r === "floating" ? "floating" : r === "stage" ? "stage" : "docked";
  }
  function placeSurface(record, body, selected, z, round, opacity, clip, concealed = false) {
    const { shell, content, controller } = record;
    const min = minSizeOf(controller.id);
    const scale = min ? Math.min(1, body.w / Math.max(1, min.width), body.h / Math.max(1, min.height)) : 1;
    const safe = Math.max(scale, 0.05);
    place(shell, body, round);
    setStyle(shell, "zIndex", String(z));
    setStyle(shell, "visibility", selected && !concealed ? "" : "hidden");
    setStyle(shell, "opacity", opacity === 1 ? "" : String(opacity));
    setStyle(shell, "clipPath", clip);
    const width = round ? Math.round(body.w / safe) : body.w / safe;
    const height = round ? Math.round(body.h / safe) : body.h / safe;
    setStyle(content, "width", `${width}px`);
    setStyle(content, "height", `${height}px`);
    setStyle(content, "transform", safe < 0.999 ? `scale(${safe})` : "");
    setAttr(shell, "data-scaled", safe < 0.999 ? "" : null);
    setAttr(shell, "inert", selected && !concealed ? null : "");
    record.__size = { width: Math.round(width), height: Math.round(height) };
    record.__scale = Math.round(safe * 1e3) / 1e3;
    const panel = panelOfView(doc, controller.id) ?? (lifted()?.views.includes(controller.id) ? lifted() : null);
    const onscreen = body.x < viewport.w && body.y < viewport.h && body.x + body.w > 0 && body.y + body.h > 0;
    const busy = !!dragActive() || gesture;
    controller.update({
      visible: selected && !concealed && onscreen && body.w > 1 && body.h > 1,
      selected,
      focused: focusedView === controller.id,
      placement: placementOf(controller.id),
      panelId: panel?.id ?? controller.state.panelId,
      interactive: !busy && safe >= 0.999,
      // Size and scale settle once motion stops: views never re-render per frame.
      ...moving() ? {} : {
        size: { width: Math.round(width), height: Math.round(height) },
        scale: Math.round(safe * 1e3) / 1e3
      }
    });
  }
  function renderDividers(round) {
    const show = !tween.active && !dragActive() && !gesture;
    for (const el of dividerEls.values()) {
      const split = findNode(doc.root, el.dataset.split);
      const e = split && entries.get(split.id);
      if (!split || !e || !show) {
        setStyle(el, "display", "none");
        continue;
      }
      const index = Number(el.dataset.index);
      const r = toScreen(e.rect);
      const total = split.weights.reduce((a, b) => a + b, 0);
      const boundary = split.weights.slice(0, index + 1).reduce((a, b) => a + b, 0) / total;
      const size = Math.max(8, gap + 4);
      const rect = split.axis === "x" ? { x: r.x + r.w * boundary - size / 2, y: r.y + pad(), w: size, h: r.h - gap } : { x: r.x + pad(), y: r.y + r.h * boundary - size / 2, w: r.w - gap, h: size };
      const visible = rect.x < viewport.w && rect.y < viewport.h && rect.x + rect.w > 0 && rect.y + rect.h > 0;
      setStyle(el, "display", visible ? "" : "none");
      place(el, rect, round);
      setAttr(el, "aria-valuenow", String(Math.round(boundary * 100)));
    }
  }
  function renderSlots(round) {
    const targets = dragger?.layoutTargets();
    for (const [el, id] of [
      [sourceSlot, SOURCE_SLOT],
      [dropSlot, DROP_SLOT]
    ]) {
      const world = targets?.get(id);
      if (!world) {
        setAttr(el, "data-visible", null);
        lastRects.delete(id);
        continue;
      }
      const r = tween.apply(id, inset(toScreen(world), pad()));
      lastRects.set(id, r);
      const visible = r.w > 8 && r.h > 8;
      setAttr(el, "data-visible", visible ? "" : null);
      if (visible) place(el, r, round);
    }
    const label = dragger?.dropLabel() ?? "";
    if (dropLabel.textContent !== label) dropLabel.textContent = label;
    setAttr(dropSlot, "data-kind", label ? "tab" : null);
  }
  function setFocus(viewId, emit = true) {
    const panel = viewId ? panelOfView(doc, viewId) : null;
    const nextPanel = panel?.id ?? null;
    if (focusedView === viewId && focusedPanel === nextPanel) return;
    focusedView = viewId;
    focusedPanel = nextPanel;
    if (nextPanel && regionOf(nextPanel) === "stage") lastStagePanel = nextPanel;
    updateTabs();
    for (const record of records.values())
      record.controller.update({ focused: record.controller.id === viewId });
    if (emit) events.emit("focus", viewId);
  }
  function focusView(viewId, moveDom) {
    if (!doc.views[viewId]) return;
    setFocus(viewId);
    raiseIfFloating(viewId);
    if (moveDom) lifetime.frame(() => moveFocusInto(viewId));
  }
  function raiseIfFloating(viewId) {
    const panel = panelOfView(doc, viewId);
    if (!panel || dragActive()) return;
    const raised = raiseFloat(doc, panel.id);
    if (raised !== doc) commit(raised, { animate: false, silent: true });
  }
  function moveFocusInto(viewId) {
    if (focusedView !== viewId) return;
    const record = records.get(viewId);
    const target = record?.content.querySelector(
      "[autofocus], iframe, input, textarea, select, button, [tabindex]:not([tabindex='-1'])"
    );
    if (target) target.focus({ preventScroll: true });
    else
      panelDoms.get(panelOfView(doc, viewId)?.id ?? "")?.tabs.get(viewId)?.el.focus({ preventScroll: true });
  }
  function selectAndFocus(viewId) {
    const next = selectView(doc, viewId);
    if (next !== doc) commit(next, { animate: false });
    focusView(viewId, false);
  }
  lifetime.listen(window, "blur", () => {
    lifetime.timeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && root.contains(active)) {
        const viewId = active.closest("[data-trellis-content]")?.dataset.trellisContent;
        if (viewId) focusView(viewId, false);
      }
    }, 0);
  });
  function infoOf(viewId) {
    const record = doc.views[viewId];
    if (!record) return null;
    const panel = panelOfView(doc, viewId) ?? (lifted()?.views.includes(viewId) ? lifted() : null);
    return {
      id: viewId,
      type: record.type,
      params: record.params ?? {},
      title: titleOf(viewId),
      panelId: panel?.id ?? "",
      placement: placementOf(viewId),
      selected: panel?.selected === viewId
    };
  }
  function allowed(viewIdsList, region) {
    return viewIdsList.every((id) => {
      const allow = typeOf(id).allow;
      if (!allow) return true;
      if (region === "stage") return allow.stage !== false;
      if (region === "side") return allow.side !== false;
      return allow.floating !== false && !!floatingLayer();
    });
  }
  function cascadeRect(layerName) {
    const c = floatContainer(layerName);
    const w = Math.min(DEFAULT_FLOAT_SIZE.w, c.w * 0.6);
    const hgt = Math.min(DEFAULT_FLOAT_SIZE.h, c.h * 0.6);
    const step = openCounter++ % 6 * 28;
    return clampFloat({
      x: (c.w * 0.5 - w / 2 + step - 70) / c.w,
      y: (c.h * 0.45 - hgt / 2 + step - 50) / c.h,
      w: w / c.w,
      h: hgt / c.h
    });
  }
  function placePanel(d, panel, placement) {
    const views = panel.views;
    const stage = findStage(d.root);
    const fl = floatingLayer();
    const focused = focusedPanel && locatePanel(d, focusedPanel) ? focusedPanel : null;
    const regionOfIn = (id) => {
      if (d.floating.some((f) => f.panel.id === id)) return "floating";
      return stage && findNode(stage, id) ? "stage" : "side";
    };
    const tryPlacements = [placement];
    if (placement !== "side") tryPlacements.push("side");
    for (const p of tryPlacements) {
      if (p === "float" || typeof p === "object" && "float" in p) {
        if (!fl || !allowed(views, "floating")) continue;
        const layerName = typeof p === "object" && "float" in p ? p.layer ?? fl : fl;
        const rect = typeof p === "object" && "float" in p ? p.float : cascadeRect(layerName);
        return floatPanel(d, panel, rect, layerName);
      }
      if (typeof p === "object" && "beside" in p) {
        const target = findNode(d.root, p.beside) ? p.beside : null;
        const region = target && stage && findNode(stage, target) && target !== stage.id ? "stage" : "side";
        if (!allowed(views, region)) continue;
        if (!target) return insertPanel(d, panel, { beside: d.root?.id ?? "", edge: p.edge, share: p.share });
        return insertPanel(d, panel, { beside: target, edge: p.edge, share: p.share });
      }
      if (typeof p === "object" && "into" in p) {
        const loc = locatePanel(d, p.into);
        const node = findNode(d.root, p.into);
        const region = node?.kind === "stage" ? "stage" : loc ? regionOfIn(p.into) : "side";
        if (!allowed(views, region) || !loc && node?.kind !== "stage") continue;
        return insertPanel(d, panel, { into: p.into, index: p.index });
      }
      if (p === "stage") {
        if (!stage) {
          if (focused && allowed(views, regionOfIn(focused))) return insertPanel(d, panel, { into: focused });
          continue;
        }
        if (!allowed(views, "stage")) continue;
        if (!stage.child) return insertPanel(d, panel, { into: stage.id });
        const inStage = panelsOf(stage);
        const target = focused && inStage.some((x) => x.id === focused) && focused || lastStagePanel && inStage.some((x) => x.id === lastStagePanel) && lastStagePanel || inStage[0].id;
        return insertPanel(d, panel, { into: target });
      }
      if (p === "tab") {
        if (focused && allowed(views, regionOfIn(focused))) return insertPanel(d, panel, { into: focused });
        if (stage) return placePanel(d, panel, "stage");
        continue;
      }
      if (p === "side") {
        if (!d.root) {
          if (allowed(views, "side")) return { ...d, root: panel };
          continue;
        }
        if (!allowed(views, "side")) break;
        if (stage && d.root.id !== stage.id) {
          return insertPanel(d, panel, { beside: stage.id, edge: "right", share: 0.25 });
        }
        return insertPanel(d, panel, {
          beside: d.root.id,
          edge: "right",
          share: stage ? 0.25 : 0.35
        });
      }
    }
    if (fl && d.root) return floatPanel(d, panel, cascadeRect(fl), fl);
    return d.root ? insertPanel(d, panel, { beside: d.root.id, edge: "right" }) : { ...d, root: panel };
  }
  function defaultPlacement(type) {
    const def = options.types[type];
    if (def?.placement) return def.placement;
    if (findStage(doc.root)) return "stage";
    if (focusedPanel) return "tab";
    return "side";
  }
  function open(type, o = {}) {
    const def = options.types[type];
    if (!def) throw Error(`Trellis: unknown view type "${type}"`);
    const reuse = o.reuse ?? (def.singleton ? "type" : "none");
    const existing = findExisting(type, o, reuse);
    if (existing) {
      reveal(existing, o.focus !== false);
      return infoOf(existing);
    }
    if (o.id && doc.views[o.id]) {
      reveal(o.id, o.focus !== false);
      return infoOf(o.id);
    }
    const id = o.id ?? uid(type);
    const withRecord = {
      ...doc,
      views: {
        ...doc.views,
        [id]: {
          type,
          ...o.params ? { params: o.params } : {},
          ...o.title ? { title: o.title } : {}
        }
      }
    };
    const panel = { kind: "panel", id: uid("panel"), views: [id], selected: id };
    const next = placePanel(withRecord, panel, o.placement ?? defaultPlacement(type));
    const from = o.from ? /* @__PURE__ */ new Map([[panel.id, towardRect(o.from, { x: 0, y: 0, w: 0, h: 0 })]]) : void 0;
    commit(next, { from });
    const appeared = panelDoms.get(panel.id);
    if (appeared && !from) appear(appeared.el, panel.views);
    if (o.focus !== false) {
      const target = panelOfView(doc, id);
      if (target && doc.floating.some((f) => f.panel.id === target.id))
        commit(raiseFloat(doc, target.id), { silent: true, animate: false });
      focusView(id, true);
      ensureFramedVisible(id);
    }
    return infoOf(id);
  }
  function appear(el, views) {
    if (reduced()) return;
    for (const node of [el, ...views.map((v) => records.get(v)?.shell).filter(Boolean)]) {
      node.removeAttribute("data-appearing");
      void node.offsetWidth;
      node.setAttribute("data-appearing", "");
      lifetime.timeout(() => node.removeAttribute("data-appearing"), MOTION.appearMs + 40);
    }
  }
  function findExisting(type, o, reuse) {
    if (!reuse || reuse === "none") return null;
    for (const id of viewIds(doc)) {
      const record = doc.views[id];
      if (record.type !== type) continue;
      if (reuse === "type") return id;
      if (reuse === "params" && stableJson(record.params ?? {}) === stableJson(o.params ?? {})) return id;
      if (typeof reuse === "function" && reuse(infoOf(id))) return id;
    }
    return null;
  }
  function reveal(viewId, focusIt) {
    const panel = panelOfView(doc, viewId);
    if (!panel) return;
    if (doc.hidden.some((x) => x.panel.id === panel.id)) restore(panel.id);
    let next = selectView(doc, viewId);
    if (doc.floating.some((f) => f.panel.id === panel.id)) next = raiseFloat(next, panel.id);
    if (next !== doc) commit(next, { animate: false });
    if (focusIt) focusView(viewId, true);
    ensureFramedVisible(viewId);
  }
  function ensureFramedVisible(viewId) {
    const panel = panelOfView(doc, viewId);
    if (panel) nav.ensureVisible(panel.id);
  }
  async function close(viewId, o = {}) {
    if (!doc.views[viewId]) return false;
    const record = records.get(viewId);
    if (!o.force && record && !await record.controller.canClose()) return false;
    if (!doc.views[viewId]) return false;
    const active = document.activeElement;
    const panelId = panelOfView(doc, viewId)?.id;
    const tabEl = panelId ? panelDoms.get(panelId)?.tabs.get(viewId)?.el : void 0;
    const hadFocus = !!active && (!!record?.shell.contains(active) || !!tabEl?.contains(active));
    commit(closeView(doc, viewId));
    if (hadFocus) {
      const next = panelId && locatePanel(doc, panelId)?.panel || (focusedView ? panelOfView(doc, focusedView) : null);
      if (next) panelDoms.get(next.id)?.tabs.get(next.selected)?.el.focus({ preventScroll: true });
      else root.focus({ preventScroll: true });
    }
    return true;
  }
  function resolvePanel(id) {
    return locatePanel(doc, id)?.panel ?? panelOfView(doc, id);
  }
  function hide(id, o = {}) {
    const owner = !locatePanel(doc, id) ? panelOfView(doc, id) : null;
    if (owner && owner.views.length > 1 && !doc.hidden.some((x) => x.panel.id === owner.id)) {
      const alone = { kind: "panel", id: uid("panel"), views: [id], selected: id };
      const detached = detachView(doc, id);
      const from2 = lastRects.get(owner.id);
      if (from2 && !reduced())
        leaving.set(alone.id, {
          panel: alone,
          from: from2,
          to: towardRect(o.toward, from2),
          start: performance.now(),
          duration: DOCK_MS.hide
        });
      commit({
        ...detached,
        hidden: [...detached.hidden, { panel: alone, restore: { kind: "tab", panel: owner.id } }]
      });
      return;
    }
    const panel = resolvePanel(id);
    if (!panel || doc.hidden.some((x) => x.panel.id === panel.id)) return;
    const from = lastRects.get(panel.id) ?? targetRect(panel.id);
    const next = hidePanel(doc, panel.id);
    if (from && !reduced()) {
      const to = towardRect(o.toward, from);
      leaving.set(panel.id, { panel, from, to, start: performance.now(), duration: DOCK_MS.hide });
    }
    commit(next);
  }
  function towardRect(toward, from) {
    if (toward && "getBoundingClientRect" in toward) {
      const b = root.getBoundingClientRect();
      const r = toward.getBoundingClientRect();
      return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
    }
    if (toward) return toward;
    return { x: from.x + from.w * 0.25, y: from.y + from.h, w: from.w * 0.5, h: from.h * 0.1 };
  }
  function restore(panelId, o = {}) {
    const hidden = doc.hidden.find((x) => x.panel.id === panelId);
    if (!hidden) return;
    leaving.delete(panelId);
    const fl = floatingLayer() || "overlay";
    const next = restorePanel(doc, panelId, fl);
    lastRects.delete(panelId);
    if (o.from && !reduced())
      entering.set(panelId, {
        from: towardRect(o.from, { x: 0, y: 0, w: 0, h: 0 }),
        start: performance.now()
      });
    commit(next);
    if (!o.from) {
      const dom = panelDoms.get(panelId);
      if (dom) appear(dom.el, hidden.panel.views);
    }
    focusView(hidden.panel.selected, true);
  }
  const rememberedFloats = /* @__PURE__ */ new Map();
  function toggleDock(id) {
    const panel = resolvePanel(id);
    if (!panel || doc.hidden.some((x) => x.panel.id === panel.id)) return;
    const stage = findStage(doc.root);
    const float2 = doc.floating.find((f) => f.panel.id === panel.id);
    const from = /* @__PURE__ */ new Map();
    const current = lastRects.get(panel.id);
    if (current) from.set(panel.id, current);
    const without = removePanel(doc, panel.id);
    if (float2) {
      if (!allowed(panel.views, "side")) return;
      settling.add(panel.id);
      rememberedFloats.set(panel.id, float2.rect);
      const s = stageScreen();
      const next = stage && without.root && findNode(without.root, stage.id) ? insertPanel(without, panel, { beside: stage.id, edge: !s || s.w >= s.h ? "right" : "bottom" }) : placePanel(without, panel, "side");
      commit(next, { from });
      nav.include(stage ? [stage.id, panel.id] : [panel.id]);
    } else {
      const layer2 = floatingLayer();
      if (!layer2 || !allowed(panel.views, "floating")) return;
      settling.add(panel.id);
      const rect = rememberedFloats.get(panel.id) ?? cascadeRect(layer2);
      commit(floatPanel(without, panel, rect, layer2), { from });
      if (stage) nav.include([stage.id]);
    }
    focusView(panel.selected, false);
  }
  function float(id, rect) {
    const fl = floatingLayer();
    if (!fl) return;
    const loc = locatePanel(doc, id);
    let d = doc;
    let panel = loc?.panel ?? null;
    if (!loc) {
      const owner = panelOfView(doc, id);
      if (!owner) return;
      if (owner.views.length > 1) {
        d = detachView(doc, id);
        panel = { kind: "panel", id: uid("panel"), views: [id], selected: id };
      } else panel = owner;
    }
    if (!panel || !allowed(panel.views, "floating")) return;
    if (locatePanel(d, panel.id)?.where === "floating" && !rect) return;
    const current = lastRects.get(panel.id) ?? lastRects.get(loc?.panel.id ?? "") ?? null;
    let target = rect;
    if (!target) {
      const base = current ?? floatScreen(cascadeRect(fl), fl);
      const w = Math.min(base.w, DEFAULT_FLOAT_SIZE.w);
      const hh = Math.min(base.h, DEFAULT_FLOAT_SIZE.h);
      target = screenToFloat(
        { x: base.x + (base.w - w) / 2 + 24, y: base.y + (base.h - hh) / 2 + 24, w, h: hh },
        fl
      );
    }
    const from = /* @__PURE__ */ new Map();
    if (current) from.set(panel.id, current);
    if (locatePanel(d, panel.id)) d = removePanel(d, panel.id);
    commit(floatPanel(d, panel, target, fl), { from });
  }
  function dock(id, target) {
    let panel = resolvePanel(id);
    if (!panel) return;
    let d = doc;
    if (!locatePanel(doc, id) && panel.views.length > 1) {
      d = detachView(doc, id);
      panel = { kind: "panel", id: uid("panel"), views: [id], selected: id };
    } else d = removePanel(doc, panel.id);
    const t = target === "stage" ? { into: findStage(d.root)?.id ?? d.root?.id ?? "" } : target;
    const from = /* @__PURE__ */ new Map();
    const current = lastRects.get(panel.id);
    if (current) from.set(panel.id, current);
    if ("into" in t && !findNode(d.root, t.into) && !locatePanel(d, t.into)) {
      commit(placePanel(d, panel, "side"), { from });
      return;
    }
    commit(d.root ? insertPanel(d, panel, t) : { ...d, root: panel }, { from });
  }
  function setTitle(viewId, title) {
    const record = doc.views[viewId];
    if (!record || record.title === title) return;
    doc = { ...doc, views: { ...doc.views, [viewId]: { ...record, title } } };
    records.get(viewId)?.controller.update({ title });
    updateTabs();
    emitChange();
  }
  function setParams(viewId, patch) {
    const record = doc.views[viewId];
    if (!record) return;
    doc = {
      ...doc,
      views: { ...doc.views, [viewId]: { ...record, params: { ...record.params ?? {}, ...patch } } }
    };
    records.get(viewId)?.controller.update({ params: doc.views[viewId].params ?? {}, title: titleOf(viewId) });
    updateTabs();
    emitChange();
  }
  function menuFor(panel) {
    const def = typeOf(panel.selected);
    const controller = records.get(panel.selected)?.controller;
    const custom = typeof def.menu === "function" ? controller ? def.menu(controller) : [] : def.menu ?? [];
    return custom;
  }
  function builtInMenu(panel) {
    const panelId = panel.id;
    const region = regionOf(panelId);
    const items = [];
    const keymap = { ...DEFAULT_KEYMAP, ...options.keymap };
    const hint = (c) => keymap[c] ? formatCombo(keymap[c]) : void 0;
    if (navigationMode() && region !== "floating")
      items.push({
        id: "maximize",
        label: framed() === panelId ? "Restore size" : "Maximize",
        shortcut: hint("frame.toggle"),
        run: () => toggleFrame(panelId)
      });
    if (region === "floating" && floatingLayer() === "stage") {
      items.push({ id: "dock", label: "Dock beside stage", run: () => toggleDock(panelId) });
    } else if (region === "floating") {
      items.push({
        id: "dock",
        label: "Dock",
        run: () => dock(
          panelId,
          findStage(doc.root) && allowed(panel.views, "stage") ? "stage" : { beside: doc.root?.id ?? "", edge: "right", share: 0.3 }
        )
      });
    } else if (floatingLayer() && allowed(panel.views, "floating")) {
      items.push({
        id: "float",
        label: "Float",
        run: () => floatingLayer() === "stage" ? toggleDock(panelId) : float(panelId)
      });
    }
    const viewId = panel.selected;
    const targets = [...panelsOf(doc.root), ...doc.floating.map((f) => f.panel)].filter(
      (p) => p.id !== panelId && allowed([viewId], regionOf(p.id))
    );
    const moves = targets.map((p) => ({
      id: `move:${p.id}`,
      label: p.views.length > 1 ? `${titleOf(p.selected)} +${p.views.length - 1}` : titleOf(p.selected),
      run: () => {
        dock(viewId, { into: p.id });
        focusView(viewId, false);
      }
    }));
    if (panel.views.length > 1 && region !== "floating")
      moves.push(
        {
          id: "split-right",
          label: "New split right",
          run: () => dock(viewId, { beside: panelId, edge: "right" })
        },
        {
          id: "split-below",
          label: "New split below",
          run: () => dock(viewId, { beside: panelId, edge: "bottom" })
        }
      );
    if (moves.length) items.push({ id: "move", label: `Move ${titleOf(viewId)} to`, items: moves });
    items.push({
      id: "hide",
      label: "Hide",
      run: () => hide(panelId, { toward: options.hideToward?.(panelId) ?? void 0 })
    });
    const closable = panel.views.filter((v) => typeOf(v).closable !== false);
    if (closable.length) {
      items.push("separator");
      if (typeOf(panel.selected).closable !== false)
        items.push({
          id: "close",
          label: `Close ${titleOf(panel.selected)}`,
          shortcut: hint("view.close"),
          run: () => void close(panel.selected)
        });
      if (panel.views.length > 1)
        items.push({
          id: "close-others",
          label: "Close other tabs",
          run: () => panel.views.filter((v) => v !== panel.selected).forEach((v) => void close(v))
        });
    }
    return items;
  }
  function panelMenuEntries(panel) {
    const setting = options.panelMenu ?? true;
    const entries2 = menuFor(panel);
    if (setting === false) return tidyMenu(entries2);
    const builtIns = builtInMenu(panel);
    const all = entries2.length ? [...entries2, "separator", ...builtIns] : builtIns;
    if (setting === true) return tidyMenu(all);
    const view = records.get(panel.selected)?.controller;
    if (!view) return tidyMenu(all);
    return tidyMenu(setting(tidyMenu(all), { panelId: panel.id, view, region: regionOf(panel.id) }));
  }
  function openPanelMenu(panelId, button, at) {
    const panel = findPanel(panelId);
    if (!panel) return;
    const entries2 = panelMenuEntries(panel);
    if (!entries2.length) return;
    const b = root.getBoundingClientRect();
    const r = button?.getBoundingClientRect();
    if (button) setAttr(button, "aria-expanded", "true");
    const reset = () => button && setAttr(button, "aria-expanded", null);
    if (options.renderMenu) {
      menu.close();
      options.renderMenu({
        entries: entries2,
        x: r ? r.right : b.left + (at?.x ?? 0),
        y: r ? r.bottom + 4 : b.top + (at?.y ?? 0),
        align: r ? "end" : "start",
        anchor: button,
        panelId,
        close: reset
      });
      return;
    }
    menuCloseHook = reset;
    if (r) menu.show(entries2, { x: r.right - b.left, y: r.bottom - b.top + 4, alignRight: true });
    else menu.show(entries2, at ?? { x: 0, y: 0 });
  }
  function tabKeydown(e, panelId) {
    const panel = findPanel(panelId);
    if (!panel) return;
    const index = panel.views.indexOf(panel.selected);
    const go = (i) => {
      e.preventDefault();
      const viewId = panel.views[(i + panel.views.length) % panel.views.length];
      const next = selectView(doc, viewId);
      if (next !== doc) commit(next, { animate: false });
      setFocus(viewId);
      panelDoms.get(panelId)?.tabs.get(viewId)?.el.focus();
    };
    switch (e.key) {
      case "ArrowRight":
        return go(index + 1);
      case "ArrowLeft":
        return go(index - 1);
      case "Home":
        return go(0);
      case "End":
        return go(panel.views.length - 1);
      case "Delete":
        if (typeOf(panel.selected).closable !== false) {
          e.preventDefault();
          void close(panel.selected);
        }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        focusView(panel.selected, true);
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        openPanelMenu(panelId, panelDoms.get(panelId).menuButton);
        return;
    }
  }
  lifetime.listen(root, "keydown", (e) => {
    if (e.defaultPrevented) return;
    if (dragActive()) return;
    const keymap = { ...DEFAULT_KEYMAP, ...options.keymap };
    const typing = e.target.matches?.(
      "input, textarea, select, [contenteditable=''], [contenteditable=true]"
    );
    for (const [command, combo] of Object.entries(keymap)) {
      if (typing && combo && !e.ctrlKey && !e.metaKey && !e.altKey) continue;
      if (combo && matches(e, combo)) {
        e.preventDefault();
        run(command);
        return;
      }
    }
    if (e.key === "Escape" && framed() && !e.target.closest?.("[data-trellis-part=content]")) {
      e.preventDefault();
      nav.stepOut();
    }
  });
  function run(command) {
    const panelId = focusedPanel;
    const panel = panelId ? findPanel(panelId) : null;
    switch (command) {
      case "frame.toggle":
        if (panelId) toggleFrame(panelId);
        return;
      case "navigation.back":
        return nav.back();
      case "navigation.forward":
        return nav.forward();
      case "navigation.overview":
        return nav.toggleOverview();
      case "panel.next":
      case "panel.previous": {
        const order = [...panelsOf(doc.root), ...doc.floating.map((f) => f.panel)];
        if (!order.length) return;
        const i = order.findIndex((p) => p.id === panelId);
        const next = order[(i + (command === "panel.next" ? 1 : -1) + order.length) % order.length];
        focusView(next.selected, false);
        panelDoms.get(next.id)?.tabs.get(next.selected)?.el.focus();
        ensureFramedVisible(next.selected);
        return;
      }
      case "tab.next":
      case "tab.previous": {
        if (!panel) return;
        const i = panel.views.indexOf(panel.selected);
        const viewId = panel.views[(i + (command === "tab.next" ? 1 : -1) + panel.views.length) % panel.views.length];
        selectAndFocus(viewId);
        return;
      }
      case "view.close":
        if (focusedView && typeOf(focusedView).closable !== false) void close(focusedView);
        return;
      case "panel.float":
        if (panelId) float(panelId);
        return;
      case "panel.hide":
        if (panelId) hide(panelId);
        return;
    }
  }
  let lastCamera = { ...UNIT };
  function cameraChanged() {
    if (sameRect2(lastCamera, camera.value)) return;
    lastCamera = { ...camera.value };
    if (events.has("camera")) events.emit("camera", { ...camera.value });
  }
  function toggleFrame(panelId) {
    const float2 = doc.floating.find((f) => f.panel.id === panelId);
    if (float2) {
      if (float2.layer !== "stage") return false;
      nav.frame("stage");
      return true;
    }
    return nav.toggle(panelId);
  }
  const framed = () => nav?.framed ?? null;
  function localPoint(ev) {
    const b = root.getBoundingClientRect();
    return { x: ev.clientX - b.left, y: ev.clientY - b.top };
  }
  function fromScreenRect(screen) {
    if (!screen) return null;
    const p = pad();
    const a = fromScreen({ x: screen.x - p, y: screen.y - p });
    const b = fromScreen({ x: screen.x + screen.w + p, y: screen.y + screen.h + p });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  function announce(text) {
    live.textContent = text;
  }
  function minExtent(node, axis) {
    if (node.kind === "stage") return node.child ? minExtent(node.child, axis) : 120;
    if (node.kind === "panel") {
      const floor = axis === "x" ? 80 : tabbarHeight + 28;
      return floor;
    }
    const mins = node.children.map((c) => minExtent(c, axis));
    const inner = node.axis === axis ? mins.reduce((a, b) => a + b, 0) + gap * (mins.length - 1) : Math.max(...mins);
    return inner;
  }
  function beginDivider(e, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    const splitId = el.dataset.split;
    const index = Number(el.dataset.index);
    const split = findNode(doc.root, splitId);
    const entry = entries.get(splitId);
    if (!split || !entry) return;
    const origin = doc;
    el.setPointerCapture(e.pointerId);
    setAttr(root, "data-resizing", split.axis);
    setAttr(el, "data-active", "");
    gesture = true;
    updateInteractivity();
    const move = (ev) => {
      const p = localPoint(ev);
      const r = toScreen(entry.rect);
      const size = split.axis === "x" ? r.w : r.h;
      const position = split.axis === "x" ? (p.x - r.x) / r.w : (p.y - r.y) / r.h;
      const current = findNode(doc.root, splitId);
      if (!current) return;
      const resized = resizeBoundary(
        current,
        index,
        position,
        (i) => minExtent(current.children[i], split.axis) / size
      );
      doc = { ...doc, root: replaceNode(doc.root, splitId, resized) };
      entries = layoutRects(doc.root);
      render();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setAttr(root, "data-resizing", null);
      setAttr(el, "data-active", null);
      gesture = false;
      const next = doc;
      doc = origin;
      commit(next, { animate: false });
      updateInteractivity();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
  function equalize(splitId, index) {
    const split = findNode(doc.root, splitId);
    if (!split) return;
    const weights = [...split.weights];
    const pair = weights[index] + weights[index + 1];
    weights[index] = weights[index + 1] = pair / 2;
    commit({ ...doc, root: replaceNode(doc.root, splitId, { ...split, weights }) });
  }
  function dividerKey(e, el) {
    const split = findNode(doc.root, el.dataset.split);
    if (!split) return;
    const index = Number(el.dataset.index);
    const decrease = split.axis === "x" ? "ArrowLeft" : "ArrowUp";
    const increase = split.axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== decrease && e.key !== increase) return;
    e.preventDefault();
    const total = split.weights.reduce((a, b) => a + b, 0);
    const boundary = split.weights.slice(0, index + 1).reduce((a, b) => a + b, 0) / total;
    const step = e.shiftKey ? 0.1 : 0.02;
    const entry = entries.get(split.id);
    const size = split.axis === "x" ? toScreen(entry.rect).w : toScreen(entry.rect).h;
    const resized = resizeBoundary(
      split,
      index,
      boundary + (e.key === increase ? step : -step),
      (i) => minExtent(split.children[i], split.axis) / size
    );
    commit({ ...doc, root: replaceNode(doc.root, split.id, resized) }, { animate: false });
  }
  function addResizeHandles(dom) {
    const wrap = h("div", { class: "trellis-handles", "data-panel": dom.id });
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handleEl = h("div", { "data-trellis-part": "resize", "data-dir": dir, "aria-hidden": "true" });
      lifetime.listen(handleEl, "pointerdown", (e) => beginFloatResize(e, dom.id, dir));
      wrap.append(handleEl);
    }
    layer.append(wrap);
    dom.handles = wrap;
  }
  function beginFloatResize(e, panelId, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const float2 = doc.floating.find((f) => f.panel.id === panelId);
    if (!float2) return;
    const start = floatScreen(float2.rect, float2.layer);
    const origin = doc;
    const startPoint = localPoint(e);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    gesture = true;
    updateInteractivity();
    setAttr(root, "data-resizing", "float");
    const minW = 160;
    const minH = tabbarHeight + 60;
    const move = (ev) => {
      const p = localPoint(ev);
      const dx = p.x - startPoint.x;
      const dy = p.y - startPoint.y;
      let { x, y, w, h: hh } = start;
      if (dir.includes("e")) w = Math.max(minW, start.w + dx);
      if (dir.includes("s")) hh = Math.max(minH, start.h + dy);
      if (dir.includes("w")) {
        w = Math.max(minW, start.w - dx);
        x = start.x + start.w - w;
      }
      if (dir.includes("n")) {
        hh = Math.max(minH, start.h - dy);
        y = start.y + start.h - hh;
      }
      const rect = screenToFloat({ x, y, w, h: hh }, float2.layer);
      doc = { ...doc, floating: doc.floating.map((f) => f.panel.id === panelId ? { ...f, rect } : f) };
      render();
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      gesture = false;
      setAttr(root, "data-resizing", null);
      const next = doc;
      doc = origin;
      commit(next, { animate: false });
      updateInteractivity();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }
  function invalidate() {
    snapshot = null;
    for (const listener of [...listeners]) listener();
  }
  function getSnapshot() {
    if (snapshot) return snapshot;
    const ids = viewIds(doc);
    for (const id of lifted()?.views ?? []) if (!ids.includes(id)) ids.push(id);
    const views = ids.map((id) => infoOf(id)).filter(Boolean);
    snapshot = {
      document: doc,
      focusedPanel,
      focusedView,
      views,
      hidden: doc.hidden.map((x) => ({
        panelId: x.panel.id,
        views: x.panel.views.map((v) => infoOf(v)).filter(Boolean)
      })),
      framed: nav.framed,
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
      framings: nav.framings.list(),
      dragging: !!dragActive()
    };
    return snapshot;
  }
  dragger = createDragController({
    root,
    lifetime,
    tween,
    lastRects,
    reduced,
    doc: () => doc,
    setDoc(next) {
      doc = next;
      sync();
      render();
    },
    commit(next, from, settle2) {
      if (settle2) settling.add(settle2);
      if (next === doc) {
        if (!reduced()) tween.begin(from, performance.now());
        sync();
        render();
        return;
      }
      commit(next, { from });
    },
    render: () => render(),
    schedule,
    busy(active) {
      updateInteractivity();
      if (active) settledState = false;
      invalidate();
    },
    closeMenus: () => menu.close(false),
    camera: () => camera.value,
    viewport: () => viewport,
    inset: pad,
    tabbarHeight: (panel) => barHeight(panel),
    toScreen,
    fromScreen,
    panelScreen: (world) => inset(toScreen(world), pad()),
    fromScreenRect,
    floatWorld(panelId) {
      const float2 = doc.floating.find((f) => f.panel.id === panelId);
      if (!float2 || float2.layer !== "stage") return null;
      const s = stageWorld();
      return {
        x: s.x + float2.rect.x * s.w,
        y: s.y + float2.rect.y * s.h,
        w: float2.rect.w * s.w,
        h: float2.rect.h * s.h
      };
    },
    floatingLayer,
    panelDom: (id) => panelDoms.get(id),
    frameOnly: (id) => !!panelDoms.get(id)?.el.hasAttribute("data-frame-only"),
    allowed,
    framedNode: () => nav.framedNode,
    minSize(viewIds2) {
      let w = 0;
      let h2 = 0;
      for (const id of viewIds2) {
        const min = minSizeOf(id);
        w = Math.max(w, min?.width ?? 0);
        h2 = Math.max(h2, min?.height ?? 0);
      }
      return { w, h: h2 };
    },
    moved(panel, from, to) {
      const stage = findStage(doc.root);
      if (to === "float" && from === "docked" && stage) nav.include([stage.id]);
      else if (to !== "float" && to !== "tab" && from === "floating") nav.include([panel.id]);
      else ensureFramedVisible(panel.selected);
      focusView(panel.selected, false);
    },
    announce
  });
  nav = createNavigator({
    root,
    lifetime,
    camera,
    doc: () => doc,
    mode: navigationMode,
    reduced,
    viewport: () => viewport,
    fromScreen,
    toScreen,
    panelScreen: (world) => inset(toScreen(world), pad()),
    setGesture(active) {
      gesture = active;
      if (active) {
        tween.stop();
        settledState = false;
      }
      updateInteractivity();
      schedule();
    },
    busy: () => dragActive(),
    contentOwnsWheel(target) {
      const surface = target.closest?.("[data-trellis-part=surface]");
      if (!surface) return false;
      return typeOf(surface.dataset.view).gestures !== "workspace";
    },
    titleOf: (node) => node.kind === "panel" ? titleOf(node.selected) : node.kind === "stage" ? "the stage" : "this group",
    schedule,
    render: () => render(),
    changed() {
      for (const [id, dom] of panelDoms) setAttr(dom.el, "data-framed", nav.framed === id ? "" : null);
      events.emit("navigate", nav.framed);
      invalidate();
      emitChange();
    }
  });
  function setDocument(next, o = {}) {
    const prepared = prepare(next);
    commit(prepared, { animate: o.animate ?? true });
    nav.restore(prepared.navigation);
  }
  applyTheme();
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth;
    const hh = host.clientHeight;
    if (w === viewport.w && hh === viewport.h) return;
    viewport = { w, h: hh };
    readMetrics();
    tween.stop();
    render();
    schedule();
  });
  ro.observe(host);
  lifetime.add(() => ro.disconnect());
  if (reducedQuery) lifetime.listen(reducedQuery, "change", () => schedule());
  lifetime.listen(root, "pointerdown", (e) => {
    if (menu.open && !e.target.closest(".trellis-menu")) menu.close(false);
  });
  {
    const initial = options.document ?? loadPersisted() ?? defaultDocument();
    doc = prepare(initial);
    sync();
    nav.restore(doc.navigation);
    camera.finish();
    const first = panelsOf(doc.root)[0] ?? doc.floating[0]?.panel;
    if (first) setFocus(first.selected, false);
    render();
  }
  const handle = {
    element: root,
    slots,
    open,
    close,
    focus: (id) => {
      const panel = locatePanel(doc, id)?.panel;
      const viewId = panel ? panel.selected : id;
      if (!doc.views[viewId]) return;
      reveal(viewId, true);
    },
    select: (viewId) => {
      const next = selectView(doc, viewId);
      if (next !== doc) commit(next, { animate: false });
    },
    hide,
    restore,
    float,
    dock,
    toggleDock,
    setTitle,
    setParams,
    navigation: {
      frame: (target) => nav.frame(target),
      toggle: (id) => {
        const target = id ?? focusedPanel;
        return target ? nav.toggle(resolvePanel(target)?.id ?? target) : false;
      },
      back: () => nav.back(),
      forward: () => nav.forward(),
      overview: () => nav.overview(),
      toggleOverview: () => nav.toggleOverview(),
      stepOut: () => nav.stepOut(),
      stepIn: () => nav.stepIn(),
      get framed() {
        return nav.framed;
      },
      get camera() {
        return { ...camera.value };
      },
      framings: nav.framings
    },
    run,
    getDocument,
    setDocument,
    reset() {
      if (options.persist)
        try {
          localStorage.removeItem(options.persist.key);
        } catch {
        }
      setDocument(defaultDocument());
    },
    views: (filter) => viewIds(doc).map((id) => infoOf(id)).filter((v) => !filter?.type || v.type === filter.type),
    view: (id) => records.get(id)?.controller ?? null,
    surfaces: () => surfacesList,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    on: (event, handler) => events.on(event, handler),
    update(patch) {
      const typesChanged = patch.types && patch.types !== options.types;
      options = { ...options, ...patch };
      if ("theme" in patch || "tokens" in patch || "navigation" in patch || "label" in patch || "tabs" in patch)
        applyTheme();
      if ("navigation" in patch && !navigationMode()) nav.focus(null, false);
      if (typesChanged) {
        for (const record of records.values()) mountContent(record);
        for (const record of records.values())
          record.controller.update({ title: titleOf(record.controller.id) });
      }
      sync();
      render();
    },
    destroy() {
      if (lifetime.disposed) return;
      dragger.cancel();
      for (const id of [...records.keys()]) destroySurface(id);
      lifetime.dispose();
      events.emit("surfaces", []);
      events.clear();
      listeners.clear();
    }
  };
  return handle;
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}
export {
  DEFAULT_KEYMAP,
  createDocument,
  createWorkspace,
  emptyDocument,
  formatCombo,
  layout,
  layoutRects,
  sanitize
};
//# sourceMappingURL=index.js.map
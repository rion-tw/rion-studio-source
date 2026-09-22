const { app, BaseWindow, WebContentsView } = require("electron");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");

app.setPath("userData", process.argv[3]);
app.setActivationPolicy("prohibited");
app.whenReady().then(async () => {
  const addon = require(resolve(`build/native/${process.platform}-${process.arch}/rion-core.node`));
  const window = new BaseWindow({ show: false, width: 900, height: 640, frame: true,
    transparent: true, backgroundColor: "#00000000" });
  window.contentView.setBackgroundColor("#00000000");
  window.setWindowButtonVisibility(true);
  const identity = { logicalWindowId: "background-probe", launchGeneration: "probe-launch", nativeGeneration: 1 };
  const native = addon.attachAppKitRuntimeHost(window.getNativeWindowHandle(), identity, () => {});
  const views = [];
  let revision = 0;
  let address;
  const observations = [];
  const attachmentStages = [];
  const initialTree = native.snapshotNativeViewTree(identity);
  const initialBackground = initialTree.filter(node => node.className === "RionWorkspaceBackgroundView");
  assert.equal(initialBackground.length, 1);
  address = initialBackground[0].address;
  const assertCoverage = () => {
    const tree = native.snapshotNativeViewTree(identity);
    const background = tree.find(node => node.address === address);
    const root = tree.find(node => node.address === background.parentAddress);
    assert.equal(background.x, 0); assert.equal(background.y, 0);
    assert.equal(background.width, root.width); assert.equal(background.height, root.height);
    return tree;
  };
  assertCoverage();
  const assertStacking = () => {
    const tree = assertCoverage();
    const background = tree.find(node => node.address === address);
    const siblings = tree.filter(node => node.parentAddress === background.parentAddress);
    assert.equal(siblings[0].address, address);
    assert.equal(siblings.at(-1).className, "RionRuntimeWorkspaceDividerOverlayView");
  };
  const project = (width, height, background) => {
    const bounds = { x: 0, y: 8, width, height };
    const dividers = [{ tabId: "tab-a", attemptGeneration: "attempt-a", dividerIndex: 0,
      axis: "vertical", bounds: { x: width / 2, y: 8, width: 16, height }, visible: true }];
    native.applyWorkspaceDividerProjection(identity, String(++revision), bounds, dividers, background);
    const tree = assertCoverage();
    const backgrounds = tree.filter(node => node.className === "RionWorkspaceBackgroundView");
    assert.equal(backgrounds.length, 1);
    address ??= backgrounds[0].address;
    assert.equal(backgrounds[0].address, address);

    const divider = tree.find(node => node.className === "RionRuntimeWorkspaceDividerView");
    assert.equal(tree.filter(node => node.parentAddress === divider.address).length, 0);
    assert.equal(tree.filter(node => node.className === "NSVisualEffectView" && node.parentAddress === address).length, 1);
    observations.push({ background, width, height, address, nativeViews: tree.length });
    return { bounds, dividers, tree };
  };
  try {
    const firstBounds = window.getBounds();
    const roleBounds = { x: 0, y: 40, width: 900, height: 540 };
    for (const background of ["black", "material"]) {
      const mounted = [];
      for (const stage of ["first-role", "second-role", "reattached-role"]) {
        native.applyTabProjection(identity, String(++revision), [{
          tabId: "tab-a", name: "A", phase: "activating", tabType: "role"
        }], "tab-a");
        native.applyWorkspaceDividerProjection(identity, String(++revision), roleBounds, [], background);
        const view = stage === "reattached-role" ? mounted[0] : new WebContentsView();
        if (stage === "reattached-role") window.contentView.removeChildView(view);
        else {
          view.setBackgroundColor("#00000000");
          view.setBounds(roleBounds);
          mounted.push(view); views.push(view);
        }
        window.contentView.addChildView(view);
        // An identical revision must detect Chromium putting the background
        // above its new sibling. Recovery restores the verified native order.
        assert.throws(() => native.applyWorkspaceDividerProjection(
          identity, String(revision), roleBounds, [], background));
        native.restoreLastVerifiedWorkspaceDividerProjection(identity);
        native.applyWorkspaceDividerProjection(identity, String(++revision), roleBounds, [], background);
        const loadingTree = native.snapshotNativeViewTree(identity);
        const status = loadingTree.find(node => node.className === "RionRuntimeStatusBackdropView");
        assert.equal(status.hidden, false);
        const siblings = loadingTree.filter(node => node.parentAddress === status.parentAddress);
        const statusIndex = siblings.findIndex(node => node.address === status.address);
        assert(siblings.every((node, index) =>
          !["ViewsCompositorSuperview", "WebContentsViewCocoa"].includes(node.className) || index < statusIndex));
        await view.webContents.loadURL("data:text/html,<body style='background:rgb(16,200,80)'>Role</body>");
        native.applyTabProjection(identity, String(++revision), [{
          tabId: "tab-a", name: "A", phase: "ready", tabType: "role"
        }], "tab-a");
        assertStacking();
        const before = native.snapshotNativeViewTree(identity);
        assert.equal(before.find(node => node.address === status.address).hidden, true);
        native.applyWorkspaceDividerProjection(identity, String(++revision), roleBounds, [], background);
        assert.deepEqual(native.snapshotNativeViewTree(identity), before);
        assert.deepEqual(window.getBounds(), firstBounds);
        attachmentStages.push({ background, stage, boundsUnchanged: true, stackingVerified: true });
      }
      for (const view of mounted) {
        window.contentView.removeChildView(view);
        view.webContents.close({ waitForBeforeUnload: false });
        views.splice(views.indexOf(view), 1);
      }
    }
    native.applyTabProjection(identity, String(++revision), [{ tabId: "tab-a", name: "A", phase: "ready", tabType: "workspace", workspaceTemplate: "two_columns" }], "tab-a");
    project(900, 540, "material");
    // Attaching content after the underlay exists must preserve one background.
    for (let i=0; i<2; i++) {
      const view = new WebContentsView();
      view.setBackgroundColor("#00000000");
      window.contentView.addChildView(view);
      views.push(view);
    }
    for (let i=0; i<12; i++) {
      const width = i % 2 ? 640 : 1200, height = i % 2 ? 400 : 800;
      window.setContentSize(width, height + 8);
      assertCoverage(); // No Core projection has arrived for the resized host.
      project(width, height, i % 3 ? "black" : "material");
    }
    const before = project(900, 540, "black");
    assert.throws(() => native.applyWorkspaceDividerProjection(identity, String(++revision),
      { ...before.bounds, width: -1 }, before.dividers, "material"));
    assert.deepEqual(native.snapshotNativeViewTree(identity), before.tree);
    window.setContentSize(1180, 760);
    assertCoverage();
    native.restoreLastVerifiedWorkspaceDividerProjection(identity);
    assertCoverage(); // Compensation restores paint, never stale coverage dimensions.
    writeFileSync(process.argv[2], JSON.stringify({ platform: process.platform, observations, attachmentStages, rejectedProjectionPreserved: true, beforeProjectionCoverage: true }));
  } finally {
    for (const view of views) view.webContents.close({ waitForBeforeUnload: false });
    native.destroy(identity);
    window.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

const coordinateAnchorDefinitions = [
  { anchor: "top-left", xPercent: 0, yPercent: 0 },
  { anchor: "top-center", xPercent: 50, yPercent: 0 },
  { anchor: "top-right", xPercent: 100, yPercent: 0 },
  { anchor: "center-left", xPercent: 0, yPercent: 50 },
  { anchor: "center", xPercent: 50, yPercent: 50 },
  { anchor: "center-right", xPercent: 100, yPercent: 50 },
  { anchor: "bottom-left", xPercent: 0, yPercent: 100 },
  { anchor: "bottom-center", xPercent: 50, yPercent: 100 },
  { anchor: "bottom-right", xPercent: 100, yPercent: 100 }
];

export function createMacroCoordinateMeasurement({
  copyCoordinate,
  getText,
  isTrustedUserEvent,
  onCancel,
  onComplete,
  root
}) {
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let copyInFlight = false;
  let destroyed = false;
  let frameId = undefined;
  let measurement = null;
  let pendingMeasurement = null;

  const picker = ownerDocument.createElement("div");
  picker.className = "coordinate-picker";
  picker.innerHTML = [
    '<div class="coordinate-anchor-layer" aria-hidden="true">',
    coordinateAnchorDefinitions.map((definition) =>
      '<div class="coordinate-anchor-marker" data-anchor="' + definition.anchor + '"></div>'
    ).join(""),
    "</div>",
    '<svg class="click-connector-svg coordinate-anchor-connector-svg" hidden aria-hidden="true" focusable="false" viewBox="0 0 1 1" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">',
    '<line class="click-connector coordinate-anchor-connector" />',
    "</svg>",
    '<div class="coordinate-line coordinate-line-horizontal"></div>',
    '<div class="coordinate-line coordinate-line-vertical"></div>',
    '<div class="coordinate-readout"></div>',
    '<div class="coordinate-hint"></div>'
  ].join("");

  const anchorLayer = picker.querySelector(".coordinate-anchor-layer");
  const connector = picker.querySelector(".coordinate-anchor-connector");
  const connectorSvg = picker.querySelector(".coordinate-anchor-connector-svg");
  const hint = picker.querySelector(".coordinate-hint");
  const readout = picker.querySelector(".coordinate-readout");
  const blockedPointerEvents = [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "wheel",
    "contextmenu"
  ];

  function getVisualViewportSize() {
    const visualViewport = ownerWindow.visualViewport;
    const documentWidth = Number(ownerDocument.documentElement?.clientWidth) || 0;
    const documentHeight = Number(ownerDocument.documentElement?.clientHeight) || 0;
    const width = Number(visualViewport?.width) || documentWidth || Number(ownerWindow.innerWidth) || 1;
    const height = Number(visualViewport?.height) || documentHeight || Number(ownerWindow.innerHeight) || 1;
    return {
      height: Math.max(1, Math.round(Number(height) || 1)),
      width: Math.max(1, Math.round(Number(width) || 1))
    };
  }

  function clampCoordinate(value, maximum) {
    return Math.max(0, Math.min(maximum - 1, Math.round(Number(value) || 0)));
  }

  function roundCoordinatePercent(value) {
    return Math.round(value * 100) / 100;
  }

  function resolveCoordinateAnchor(value, viewport) {
    let nearestAnchor = coordinateAnchorDefinitions[0].anchor;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    coordinateAnchorDefinitions.forEach((definition) => {
      const anchorX = (viewport.width * definition.xPercent) / 100;
      const anchorY = (viewport.height * definition.yPercent) / 100;
      const deltaX = value.xPx - anchorX;
      const deltaY = value.yPx - anchorY;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestAnchor = definition.anchor;
      }
    });
    return nearestAnchor;
  }

  function resolveCoordinateAnchorPosition(anchorValue, viewport) {
    const definition = coordinateAnchorDefinitions.find((candidate) => candidate.anchor === anchorValue)
      ?? coordinateAnchorDefinitions[0];
    return {
      xPx: clampCoordinate((viewport.width * definition.xPercent) / 100, viewport.width),
      yPx: clampCoordinate((viewport.height * definition.yPercent) / 100, viewport.height)
    };
  }

  function measurementFromPoint(xPx, yPx, viewport = getVisualViewportSize()) {
    const value = {
      xPercent: roundCoordinatePercent((xPx / viewport.width) * 100),
      xPx,
      viewportHeightPx: viewport.height,
      viewportWidthPx: viewport.width,
      yPercent: roundCoordinatePercent((yPx / viewport.height) * 100),
      yPx
    };
    return {
      ...value,
      anchor: resolveCoordinateAnchor(value, viewport)
    };
  }

  function measurementFromEvent(event) {
    const viewport = getVisualViewportSize();
    return measurementFromPoint(
      clampCoordinate(event.clientX, viewport.width),
      clampCoordinate(event.clientY, viewport.height),
      viewport
    );
  }

  function formatMeasurement(value) {
    return [
      "X: ",
      String(value.xPx),
      "px (",
      String(roundCoordinatePercent(value.xPercent)),
      "%), Y: ",
      String(value.yPx),
      "px (",
      String(roundCoordinatePercent(value.yPercent)),
      "%), ",
      getText().coordinateAnchor,
      ": ",
      String(value.anchor || coordinateAnchorDefinitions[0].anchor)
    ].join("");
  }

  function updateAnchorConnector(value, viewport) {
    if (!connector || !connectorSvg) return;
    const anchor = resolveCoordinateAnchorPosition(value.anchor, viewport);
    connectorSvg.setAttribute(
      "viewBox",
      ["0", "0", String(viewport.width), String(viewport.height)].join(" ")
    );
    connector.setAttribute("x1", String(anchor.xPx));
    connector.setAttribute("y1", String(anchor.yPx));
    connector.setAttribute("x2", String(value.xPx));
    connector.setAttribute("y2", String(value.yPx));
    if (anchor.xPx === value.xPx && anchor.yPx === value.yPx) {
      connectorSvg.setAttribute("hidden", "");
    } else {
      connectorSvg.removeAttribute("hidden");
    }
  }

  function setReadoutStatus(status) {
    if (!readout) return;
    readout.dataset.status = status || "ready";
    if (status === "copying") {
      readout.textContent = getText().coordinateCopying;
      return;
    }
    if (status === "failed") {
      readout.textContent = getText().coordinateCopyFailed;
      return;
    }
    if (measurement) {
      readout.textContent = formatMeasurement(measurement);
    }
  }

  function updateAnchorGuides(viewport = getVisualViewportSize()) {
    if (!anchorLayer) return;
    const markers = anchorLayer.querySelectorAll(".coordinate-anchor-marker");
    coordinateAnchorDefinitions.forEach((definition, index) => {
      const marker = markers[index];
      if (!marker) return;
      marker.style.left = String(
        clampCoordinate((viewport.width * definition.xPercent) / 100, viewport.width)
      ) + "px";
      marker.style.top = String(
        clampCoordinate((viewport.height * definition.yPercent) / 100, viewport.height)
      ) + "px";
    });
  }

  function updateMeasurement(value) {
    measurement = value;
    const viewport = getVisualViewportSize();
    updateAnchorGuides(viewport);
    updateAnchorConnector(value, viewport);
    picker.style.setProperty("--coordinate-x", String(value.xPx) + "px");
    picker.style.setProperty("--coordinate-y", String(value.yPx) + "px");
    picker.style.setProperty("--coordinate-width", String(viewport.width) + "px");
    picker.style.setProperty("--coordinate-height", String(viewport.height) + "px");
    if (!readout) return;
    setReadoutStatus("ready");
    const readoutBounds = readout.getBoundingClientRect?.();
    const readoutWidth = Math.max(
      1,
      Number(readoutBounds?.width) || Number(readout.offsetWidth) || 280
    );
    const readoutHeight = Math.max(
      1,
      Number(readoutBounds?.height) || Number(readout.offsetHeight) || 42
    );
    const edgePaddingPx = 8;
    const gapPx = 14;
    const maxLeft = Math.max(edgePaddingPx, viewport.width - readoutWidth - edgePaddingPx);
    const maxTop = Math.max(edgePaddingPx, viewport.height - readoutHeight - edgePaddingPx);
    const preferredLeft = value.xPx + gapPx;
    const preferredTop = value.yPx + gapPx;
    const leftOfMeasurement = value.xPx - gapPx - readoutWidth;
    const topOfMeasurement = value.yPx - gapPx - readoutHeight;
    readout.style.left = String(
      preferredLeft > maxLeft && leftOfMeasurement >= edgePaddingPx
        ? leftOfMeasurement
        : Math.min(preferredLeft, maxLeft)
    ) + "px";
    readout.style.top = String(
      preferredTop > maxTop && topOfMeasurement >= edgePaddingPx
        ? topOfMeasurement
        : Math.min(preferredTop, maxTop)
    ) + "px";
  }

  function cancelMeasurementFrame() {
    if (frameId !== undefined) {
      ownerWindow.cancelAnimationFrame(frameId);
      frameId = undefined;
    }
    pendingMeasurement = null;
  }

  function flushMeasurement() {
    if (frameId !== undefined) {
      ownerWindow.cancelAnimationFrame(frameId);
      frameId = undefined;
    }
    const value = pendingMeasurement;
    pendingMeasurement = null;
    if (value && !destroyed) updateMeasurement(value);
  }

  function scheduleMeasurement(value) {
    pendingMeasurement = value;
    if (frameId !== undefined) return;
    frameId = ownerWindow.requestAnimationFrame(() => {
      frameId = undefined;
      const nextMeasurement = pendingMeasurement;
      pendingMeasurement = null;
      if (nextMeasurement && !destroyed) updateMeasurement(nextMeasurement);
    });
  }

  function handleViewportResize() {
    if (destroyed) return;
    if (measurement) {
      const viewport = getVisualViewportSize();
      updateMeasurement(measurementFromPoint(
        clampCoordinate((measurement.xPercent * viewport.width) / 100, viewport.width),
        clampCoordinate((measurement.yPercent * viewport.height) / 100, viewport.height),
        viewport
      ));
      return;
    }
    updateAnchorGuides();
  }

  function handlePointerMove(event) {
    if (destroyed) return;
    event.preventDefault();
    event.stopPropagation();
    scheduleMeasurement(measurementFromEvent(event));
  }

  function blockPointerEvent(event) {
    if (destroyed) return;
    event.preventDefault();
    event.stopPropagation();
  }

  async function handleClick(event) {
    if (destroyed || copyInFlight || !isTrustedUserEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pendingMeasurement = measurementFromEvent(event);
    flushMeasurement();
    if (!measurement) return;
    copyInFlight = true;
    setReadoutStatus("copying");
    try {
      const coordinate = { ...measurement };
      delete coordinate.anchor;
      await copyCoordinate(coordinate);
      if (!destroyed) onComplete();
    } catch (error) {
      if (destroyed) return;
      copyInFlight = false;
      setReadoutStatus("failed");
      console.warn("Unable to copy Rion Studio game coordinates.", error);
    }
  }

  function handleKeyDown(event) {
    if (destroyed) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") onCancel();
    return true;
  }

  function handleKeyPress(event) {
    if (destroyed) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function handleKeyUp(event) {
    if (destroyed) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function updatePresentation() {
    if (destroyed) return;
    if (hint) hint.textContent = getText().coordinateMeasureHint;
    if (measurement && readout?.dataset.status === "ready") setReadoutStatus("ready");
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    copyInFlight = false;
    measurement = null;
    cancelMeasurementFrame();
    ownerWindow.removeEventListener("resize", handleViewportResize, true);
    ownerWindow.visualViewport?.removeEventListener("resize", handleViewportResize);
    picker.removeEventListener("pointermove", handlePointerMove);
    picker.removeEventListener("mousemove", handlePointerMove);
    blockedPointerEvents.forEach((eventName) => {
      picker.removeEventListener(eventName, blockPointerEvent);
    });
    picker.removeEventListener("click", handleClick);
    picker.remove();
  }

  root.appendChild(picker);
  picker.addEventListener("pointermove", handlePointerMove);
  picker.addEventListener("mousemove", handlePointerMove);
  blockedPointerEvents.forEach((eventName) => {
    picker.addEventListener(eventName, blockPointerEvent, { passive: false });
  });
  picker.addEventListener("click", handleClick);
  ownerWindow.addEventListener("resize", handleViewportResize, true);
  ownerWindow.visualViewport?.addEventListener("resize", handleViewportResize);
  updatePresentation();
  const viewport = getVisualViewportSize();
  updateMeasurement(measurementFromPoint(
    Math.floor(viewport.width / 2),
    Math.floor(viewport.height / 2),
    viewport
  ));

  return {
    destroy,
    handleKeyDown,
    handleKeyPress,
    handleKeyUp,
    updatePresentation
  };
}

(function shouldIgnoreMacroShortcutEvent(event, activeElement, designMode) {
  if (
    event.isComposing ||
    event.key === "Process" ||
    event.keyCode === 229 ||
    designMode?.toLowerCase() === "on"
  ) {
    return true;
  }

  function hasEditableContext(candidate) {
    const pending = [candidate];
    const visited = new Set();

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || visited.has(current)) {
        continue;
      }
      visited.add(current);

      const rawName = typeof current.localName === "string"
        ? current.localName
        : current.tagName;
      const name = typeof rawName === "string" ? rawName.toLowerCase() : "";

      if (
        name === "input" ||
        name === "textarea" ||
        name === "select" ||
        current.isContentEditable === true
      ) {
        return true;
      }

      if (typeof current.getAttribute === "function") {
        const contentEditable = current.getAttribute("contenteditable");
        if (contentEditable !== null && contentEditable.toLowerCase() !== "false") {
          return true;
        }

        const editableRoles = ["textbox", "searchbox", "combobox", "spinbutton"];
        const roles = current.getAttribute("role")?.toLowerCase().split(/\s+/) ?? [];
        if (roles.some((role) => editableRoles.includes(role))) {
          return true;
        }
      }

      pending.push(
        current.parentElement,
        current.parentNode?.host,
        current.shadowRoot?.activeElement
      );

      if (typeof current.getRootNode === "function") {
        try {
          const root = current.getRootNode();
          pending.push(root?.host);
        } catch {
          // Ignore page-owned DOM accessors that throw.
        }
      }
    }

    return false;
  }

  let eventPath = [];
  try {
    eventPath = event.composedPath();
  } catch {
    // Fall back to the target and active element for synthetic events.
  }

  return [...eventPath, event.target, activeElement].some(hasEditableContext);
})

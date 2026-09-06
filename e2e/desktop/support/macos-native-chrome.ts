/** Bounded AX traversal for native chrome. Remote WebAreas are never descended. */
export const MACOS_NATIVE_CHROME_ELEMENTS = `
on nativeChromeElements(rootElement)
  set pendingElements to {rootElement}
  set nativeElements to {}
  set nextIndex to 1
  tell application "System Events"
    repeat while nextIndex is less than or equal to count of pendingElements
      if nextIndex is greater than 512 then error "native chrome AX traversal exceeded its bound"
      set currentElement to item nextIndex of pendingElements
      set nextIndex to nextIndex + 1
      set elementRole to role of currentElement
      if elementRole is not "AXWebArea" then
        set end of nativeElements to currentElement
        set childElements to UI elements of currentElement
        if (count of pendingElements) + (count of childElements) is greater than 512 then ¬
          error "native chrome AX traversal exceeded its bound"
        repeat with childElement in childElements
          set end of pendingElements to contents of childElement
        end repeat
      end if
    end repeat
  end tell
  return nativeElements
end nativeChromeElements
`;

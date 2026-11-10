// A modal dialog of the sheet closes when the pointer goes down outside it, on the backdrop, as
// well as by its own button and Escape. The backdrop is the dialog element itself as far as an
// event can tell, and so is the dialog's padding: the pointer's place decides. On the press, not
// the click, so a text selection dragged out of the dialog does not close it.
export function closeOnBackdrop(event: PointerEvent): void {
  const dialog = event.currentTarget
  if (!(dialog instanceof HTMLDialogElement) || event.target !== dialog) return
  const box = dialog.getBoundingClientRect()
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
  if (!inside) dialog.close()
}

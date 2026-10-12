import { ControlKey, KeyboardMode, type KeyEvent } from "./generated/kessoku_wire";

export function keyboardModifiers(event: KeyboardEvent): ControlKey[] {
  const output: ControlKey[] = [];
  if (event.altKey) output.push(ControlKey.Alt);
  if (event.shiftKey) output.push(ControlKey.Shift);
  if (event.ctrlKey) output.push(ControlKey.Control);
  if (event.metaKey) output.push(ControlKey.Meta);
  return output;
}

export function keyEvent(event: KeyboardEvent, down: boolean): KeyEvent | undefined {
  if (event.isComposing || event.repeat) return undefined;
  const controls: Readonly<Record<string, ControlKey>> = {
    Alt: ControlKey.Alt, Backspace: ControlKey.Backspace, CapsLock: ControlKey.CapsLock, Control: ControlKey.Control,
    Delete: ControlKey.Delete, ArrowDown: ControlKey.DownArrow, End: ControlKey.End, Escape: ControlKey.Escape,
    F1: ControlKey.F1, F2: ControlKey.F2, F3: ControlKey.F3, F4: ControlKey.F4, F5: ControlKey.F5, F6: ControlKey.F6,
    F7: ControlKey.F7, F8: ControlKey.F8, F9: ControlKey.F9, F10: ControlKey.F10, F11: ControlKey.F11, F12: ControlKey.F12,
    Home: ControlKey.Home, ArrowLeft: ControlKey.LeftArrow, Meta: ControlKey.Meta, PageDown: ControlKey.PageDown,
    PageUp: ControlKey.PageUp, Enter: ControlKey.Return, ArrowRight: ControlKey.RightArrow, Shift: ControlKey.Shift,
    " ": ControlKey.Space, Tab: ControlKey.Tab, ArrowUp: ControlKey.UpArrow, Insert: ControlKey.Insert,
  };
  const base = { down, press: false, modifiers: keyboardModifiers(event), mode: KeyboardMode.Legacy };
  const controlKey = controls[event.key];
  if (controlKey !== undefined) return { ...base, controlKey, chr: undefined, unicode: undefined, seq: undefined };
  const points = Array.from(event.key);
  if (points.length === 1) {
    return { ...base, controlKey: undefined, chr: points[0]!.codePointAt(0), unicode: undefined, seq: undefined };
  }
  return undefined;
}

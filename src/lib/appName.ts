/**
 * The app's name in shared user-facing text. The desktop app is Margin; the Obsidian plugin (Readside)
 * sets its own name when its main module loads. Only sentences the user reads use it, never identifiers.
 */
let name = 'Margin';

export function appName(): string {
  return name;
}

export function setAppName(next: string): void {
  name = next;
}

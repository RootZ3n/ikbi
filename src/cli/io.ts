import { writeSync } from "node:fs";

export function writeStdout(s: string): void {
  writeSync(1, s);
}

export function writeStderr(s: string): void {
  writeSync(2, s);
}

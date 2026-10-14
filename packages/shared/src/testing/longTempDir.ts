// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

// GitHub's Windows runners hand out the temp directory by its 8.3 short name
// (C:\Users\RUNNER~1\...). Anything that canonicalises a path, such as git or
// realpath, reports the long form, so equality checks between a temp path and
// its canonical form fail. Node reads TEMP/TMP on every os.tmpdir() call, so
// pointing them at the long form fixes every temp directory the suite makes.
// Keep this file free of imports beyond node:fs/node:os: it is a test setup file
// for every package, including browser-like jsdom environments that cannot load
// the HostProcess module's node:sea dependency.
// oxlint-disable-next-line t3code/no-global-process-runtime -- test setup outside any Effect runtime; importing HostProcess would pull node:sea into jsdom setup graphs.
if (process.platform === "win32") {
  try {
    const longForm = NodeFS.realpathSync.native(NodeOS.tmpdir());
    process.env.TEMP = longForm;
    process.env.TMP = longForm;
  } catch {
    // Leave the host's value alone if it cannot be resolved.
  }
}

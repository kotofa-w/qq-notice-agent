// UNC/device paths and drive-relative paths are outside the Windows first release.
export function isLocalAbsolutePath(value, platform = process.platform) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) return false;
  return platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(value) && !value.slice(2).includes(":")
    : value.startsWith("/") && !value.startsWith("//");
}

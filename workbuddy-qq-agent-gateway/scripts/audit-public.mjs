// Audit the index, not the deployment directory. Never print a matched secret.
import { execFileSync } from "node:child_process";
const entries = execFileSync("git", ["ls-files","--stage","-z"], {encoding:"utf8"}).split("\0").filter(Boolean);
const errors = [];
// The outer workspace also tracks deployment source, never its live state.
const deploymentSources = new Set([
  "check-runtime.ps1", "configure-qq.ps1", "copy-panel-token.ps1", "install-startup.ps1",
  "protect-runtime-config.ps1", "restart-hub.ps1", "run-qq-bridge.ps1", "run-qq-desktop-bridge.ps1",
  "start-qq-with-notices.ps1", "install-qq-notice-startup.ps1",
  "run-runtime.ps1", "runtime-control.ps1", "runtime-credentials.ps1", "uninstall-startup.ps1"
].map((name) => `runtime/${name}`));
for (const [component, names] of Object.entries({
  "caldav-fruux": [".gitignore", "README.md", "configure-gateway.ps1", "discover.ps1", "discover.py", "setup-credentials.ps1", "verify-deployment.ps1", "verify-project.mjs", "verify-project.ps1"],
  "caldav-radicale": [".gitignore", "README.md", "campus-probe.py", "copy-password.ps1", "requirements.lock.txt", "run.ps1", "verify-auth.ps1", "verify-local.py"],
  "napcat-framework-v4.18.33": ["README.md"]
})) for (const name of names) deploymentSources.add(`runtime/${component}/${name}`);
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["cloud access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/]
];
for (const entry of entries) {
  const [,mode,oid,stage,path] = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/) || [];
  if (!path) { errors.push("Invalid index entry");continue; }
  if (!["100644", "100755"].includes(mode) || stage !== "0") errors.push(path+": unsupported file mode or unresolved merge");
  const auditPath = path.toLowerCase();
  const sourcePath = auditPath.replace(/^workbuddy-qq-agent-gateway\//, "");
  if (/(^|\/)(?:data|private|logs|runtime[^/]*|workspaces|vendor|downloads|backups|apps|build|node_modules|\.venv|__pycache__|\.github-publication)\//.test(auditPath) && !deploymentSources.has(path)
    || /(?:\.session-map\.json|\.(?:log|db|sqlite3?|pid|sock|pyc|dpapi|clixml|key|pem|pfx|p12))$/.test(auditPath)
    || /^(?:checkpoint_status|交接说明|审阅交付记录|实现复盘_[^/]+)\.md$/.test(auditPath)
    || (sourcePath.startsWith("config/") && (sourcePath.endsWith(".plist") || sourcePath === "config/qq-only.env"))
    || /(^|\/)\.env(?:\..*)?$/.test(auditPath) && !auditPath.endsWith(".example")) {
    errors.push(path+": forbidden deployment state");
  }
  const data = execFileSync("git",["cat-file","blob",oid]);
  if (path.endsWith(".png")) {
    if (data.subarray(0,8).toString("hex") !== "89504e470d0a1a0a") { errors.push(path+": invalid PNG");continue; }
    for (let offset=8;offset+12<=data.length;) {
      const size=data.readUInt32BE(offset),type=data.subarray(offset+4,offset+8).toString();
      if (offset+12+size>data.length) {errors.push(path+": malformed PNG");break;}
      if (["eXIf","tEXt","zTXt","iTXt"].includes(type)) errors.push(path+": image metadata needs review");
      offset+=12+size;
    }
    continue;
  }
  if (data.includes(0)) {errors.push(path+": unexpected binary");continue;}
  const text=data.toString("utf8");
  for (const [label,regex] of secretPatterns) if (regex.test(text)) errors.push(path+": possible "+label);
}
if (!entries.length) errors.push("Index is empty: stage the reviewed release before auditing");
if (errors.length) {console.error(errors.join("\n"));process.exitCode=1;}
else console.log("Public index audit passed: "+entries.length+" files; no deployment state, recognized credentials or PNG metadata.");

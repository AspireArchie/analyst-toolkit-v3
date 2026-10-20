# SOP: Install and run Analyst Toolkit v3 on Windows

**Version:** 1.0

**Reviewed:** 19 October 2026

**Scope:** Windows workstations; first installation, subsequent launches and updates.

**Repository:** [AspireArchie/analyst-toolkit-v3](https://github.com/AspireArchie/analyst-toolkit-v3)

## 1. Prerequisites

Use your own Windows and GitHub accounts. Confirm you can open the repository in a browser; if access is restricted, ask the repository owner to grant access and accept any invitation before continuing.

Install the following using your organisation's approved software process:

| Component | Requirement | Official installation source |
| --- | --- | --- |
| Git for Windows | Git available from a terminal; retain Git Credential Manager during installation | [Git for Windows](https://git-scm.com/install/windows) |
| Node.js and npm | Node.js 24 LTS recommended. The currently locked Electron dependency requires Node.js 22.12.0 or later. Include npm and add Node.js to PATH. | [Node.js Windows installer](https://nodejs.org/en/download) |
| PowerShell 7 | Required for BEC investigation modules. Not required for the standalone Toolkit modules. Windows PowerShell 5.1 does not satisfy this requirement. | [Microsoft installation instructions](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows) |

You need internet access for the initial Git clone and dependency downloads. Microsoft investigations and OSINT provider lookups also require access to their respective services. Use a writable, per-user installation folder so the application can create investigation logs.

After installing prerequisites, close and reopen your terminal so PATH changes take effect. Run these commands in PowerShell:

```powershell
git --version
node --version
npm.cmd --version
```

Each command must return a version. If using BEC investigation modules, also check:

```powershell
pwsh --version
```

This must report PowerShell 7.x or later supported by your organisation. Installers may require IT assistance; run the application with your normal user account.

## 2. Download the application — first installation only

Open PowerShell and run:

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\source" -Force | Out-Null
Set-Location "$env:USERPROFILE\source"
git clone https://github.com/AspireArchie/analyst-toolkit-v3.git
Set-Location ".\analyst-toolkit-v3"
```

If prompted, complete GitHub authentication in your browser using an account with access to the repository. Complete any required MFA or organisation authorisation.

If the destination folder already exists, use the update procedure in section 6 instead of cloning over it.

Verify that you are in the project folder:

```powershell
Get-Item .\package.json, .\package-lock.json
```

Both files must be present. A GitHub ZIP download is not used in this procedure because it does not retain the Git history needed for `git pull` updates.

## 3. Install dependencies

From the `analyst-toolkit-v3` folder, run:

```powershell
npm.cmd ci --include=dev
```

Wait for the command to finish successfully before proceeding. This installs the locked dependencies, including Electron and the compiler used to start the app. `npm ci` uses the existing lock file and does not update it. See [npm's clean-install documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

The `.cmd` form works from PowerShell without depending on permission to execute npm's PowerShell wrapper script.

## 4. Launch and confirm operation

Run:

```powershell
npm.cmd start
```

Startup builds the application and opens the desktop window. Confirm that:

- The top-left header displays the Aspire logo and **Analyst Toolkit**.
- The **Session** page opens and the Toolkit tabs are available in the sidebar.
- **Data Tools** opens and produces output when you paste an IP address and choose Defang.

For later launches, either double-click **Start BEC Bot.bat** in the project folder, or run:

```powershell
Set-Location "$env:USERPROFILE\source\analyst-toolkit-v3"
npm.cmd start
```

The batch file retains its original BEC Bot filename. There is no separate packaged installer in this repository; launch it using the supplied script or npm command. Keep the launch terminal open while working. Close the application and any Notepad pop-out windows when finished.

## 5. Initial configuration

### Toolkit use

**Data Tools, KQL Library, Notepad and Browser History** do not need a Microsoft connection. Browser History imports a closed-browser copy of Chrome/Edge's `History` or Firefox's `places.sqlite`; keep any matching `-wal` file alongside the copied database.

For **OSINT Toolkit**, open **Settings**, enter the API keys you have for VirusTotal, AbuseIPDB and IPData, then choose **Save API keys**. Each provider requires its own key. A missing key leaves that provider unavailable while other configured providers can still run. Keys are stored locally, encrypted for the Windows account.

### BEC investigation use

Complete this section only if you will collect Microsoft investigation evidence:

1. Confirm `pwsh --version` succeeds, then open **Session**.
2. Select **Install modules** and wait for successful completion. This installs `Microsoft.Graph.Authentication` and `ExchangeOnlineManagement` for the current user.
3. Enter the affected organisation's Microsoft Entra **tenant ID** in GUID format.
4. Select **Connect Graph**. Follow the device sign-in instructions shown in **Session output**, completing the browser sign-in using an authorised analyst account.
5. For Exchange-dependent workflows, including UAL collection, select **Connect Exchange** and complete its separate sign-in for the same tenant.
6. Confirm the relevant connection indicator is green before collecting evidence.

Tenant administrators must provide the required roles, consent and licensing for the selected investigation modules. Installing the application or modules does not grant tenant permissions. The repository's [README](../README.md) documents the requested Graph scopes and module coverage.

## 6. Pull updates

Before updating, export any investigation evidence you need and explicitly save any Notepad changes you want to retain. Close the application, including Notepad pop-outs.

Open PowerShell:

```powershell
Set-Location "$env:USERPROFILE\source\analyst-toolkit-v3"
git status --short
```

If the command lists modified or untracked files, preserve those files and ask the maintainer how to proceed. Do not reset or overwrite local work to complete an update.

If the working tree is clean, run:

```powershell
git pull --ff-only origin main
npm.cmd ci --include=dev
npm.cmd start
```

If any command fails, stop and resolve that error before running the next command. If Git reports that the branches have diverged, ask the maintainer to resolve it rather than forcing the update.

## 7. Local information and retention

| Information | Location or behaviour |
| --- | --- |
| Investigation transcripts | `session_logs` inside the cloned project folder. Logs can contain investigation information. |
| Exported evidence | The destination chosen in the app's save dialog. |
| Saved API keys | `api-keys.enc` in the app's user-data directory; encrypted for the Windows account. |
| Saved KQL templates | Local browser storage within the app's user-data directory. |
| Saved Notepad snapshots | `notepad.json` in the app's user-data directory. Only an explicit **Save locally** action persists a note. |
| Unsaved notes and later edits | Memory only; discarded when the application exits. |

For this checkout, the default Windows user-data directory is `%APPDATA%\bec-bot`. Keep that directory if you want to retain local settings and saved information. A Git clone on another device does not transfer these items, API keys, logs or exported evidence.

## 8. Troubleshooting

| Symptom | Action |
| --- | --- |
| `git`, `node` or `npm.cmd` is not recognised | Confirm the prerequisite is installed, then close and reopen the terminal. Ask IT to check PATH if it still fails. |
| GitHub reports repository not found or access denied | Confirm you can open the repository using your own GitHub account and that any invitation has been accepted. |
| GitHub reports an invalid username or token | Refresh Git Credential Manager sign-in using the command below, then retry the clone or pull. |
| Clone says the destination already exists | Use section 6 if it is an existing checkout; otherwise choose a different empty destination folder. |
| npm reports an unsupported Node.js version | Install the approved Node.js 24 LTS version, reopen the terminal and verify `node --version` before retrying. |
| `npm ci` reports a lock-file mismatch | Confirm you pulled the intended branch. Send the error to the maintainer; do not regenerate the lock file as an installation workaround. |
| Dependency or Electron download fails | Check the failed host/error with IT for proxy, network or download restrictions, then retry the dependency installation. |
| npm PowerShell script execution is blocked | Use the `npm.cmd` commands provided in this SOP. |
| `pwsh.exe` cannot start | Install PowerShell 7 and restart the terminal and app so the updated PATH is inherited. |
| PowerShell execution is blocked by device policy | Ask IT to approve the required application scripts through the organisation's normal policy process. |
| Graph/Exchange returns access or consent errors | Check the selected tenant, analyst permissions, consent and applicable licensing with the tenant administrator. |
| Application cannot start investigation logging | Check that the project folder is writable and that local security controls allow the app to write `session_logs`. |
| App closes during startup or the build fails | Run `npm.cmd start` from PowerShell and retain the displayed error. Run `npm.cmd run check` to capture compiler errors for the maintainer. |

To refresh GitHub sign-in when required:

```powershell
git credential-manager github login --force --browser
```

Use your own authorised GitHub account in the browser, then retry the Git command that failed.

When escalating an issue, provide the command that failed, its error text, your Node/npm/PowerShell versions and the installed commit:

```powershell
git rev-parse --short HEAD
```

Review diagnostic material for investigation data and credentials before sharing it outside the authorised support channel.

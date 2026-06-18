# NovaSpeak — Codex Project Instructions

## 1. Project overview

NovaSpeak is a lightweight private voice and chat application for the NOVA GAMING team.

Core technologies:

* Frontend: React + Vite
* Backend: Node.js + Express
* Database: SQLite with `better-sqlite3`
* Voice service: LiveKit Cloud
* Authentication: HttpOnly cookies
* Deployment entry: Express serves `client/dist`
* Public domain: `https://voice.novagaming.top`
* Local project path: `C:\Users\zkcsk\Desktop\NovaSpeak`

Project structure:

```text
NovaSpeak/
├─ client/
│  ├─ src/
│  │  ├─ components/
│  │  └─ App.jsx
│  ├─ package.json
│  └─ dist/
├─ server/
│  ├─ index.js
│  ├─ db.js
│  ├─ auth-session.js
│  ├─ auth-utils.js
│  ├─ guest-auth.js
│  ├─ data/
│  ├─ scripts/
│  ├─ package.json
│  └─ .env
└─ AGENTS.md
```

Before making changes, inspect the current repository. Do not assume that code from an earlier task is still identical to the current code.

---

## 2. Working method

For every task:

1. Read this `AGENTS.md`.
2. Run `git status` and identify the current branch.
3. Inspect all relevant files and call sites.
4. Search the repository for related identifiers and routes.
5. Describe the current implementation before modifying it.
6. Make the smallest compatible change.
7. Run relevant tests and builds.
8. Report actual results, not expected results.

Do not rewrite entire working files unless a full rewrite is clearly necessary.

Do not silently remove existing features.

Do not claim a task is complete when builds or required tests fail.

---

## 3. User environment

The user runs the project locally using Windows PowerShell.

When providing commands for the user, use PowerShell-compatible commands.

Prefer:

```powershell
Select-String
Copy-Item
Remove-Item
Add-Content
Get-Content
Set-Content
```

Do not tell the user to run Linux-only commands such as:

```text
grep
printf
cp
rm
export
```

Inside a Codex Linux sandbox, environment-native commands may be used for internal work, but final instructions for the user must be translated into Windows PowerShell.

Local commands commonly used by the user:

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client
npm run build
```

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\server
npm run dev
```

If `npm run dev` is not defined, inspect `server/package.json` before recommending another command.

---

## 4. Application architecture

Express handles API routes and serves the production frontend.

All `/api/*` routes must be registered before:

```js
app.use(express.static(clientDistPath));
```

and before the SPA fallback that returns `index.html`.

Unmatched API routes must return JSON, not HTML.

Keep an API fallback similar to:

```js
app.use("/api", (req, res) => {
  res.status(404).json({
    error: `API 不存在：${req.method} ${req.originalUrl}`,
  });
});
```

This prevents frontend errors such as:

```text
Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

Frontend requests must:

* use the existing `API_BASE`
* use `credentials: "include"` for authenticated requests
* check the response content type before parsing JSON
* handle `response.ok`
* show understandable Chinese errors
* avoid unhandled promises

---

## 5. Authentication roles

Permissions are controlled only by `role`.

Supported roles:

```text
admin
member
guest
```

### Admin

An admin can:

* view and modify their own formal account
* manage all formal team members
* create formal member accounts
* modify member nicknames
* modify member positions
* reset member passwords
* delete eligible member accounts
* create, edit, and delete channels
* join voice channels
* use chat
* view public team information

### Member

A member can:

* view their own formal account
* modify their own nickname
* modify their own password
* view their positions
* not modify their own positions
* not modify their role
* create, edit, and delete channels
* join voice channels
* use chat
* view public team information
* not manage other formal member accounts

### Guest

A guest can:

* enter using a temporary nickname
* view public team information
* view available channels
* join permitted voice channels
* use existing basic chat features
* leave guest mode

A guest cannot:

* create, edit, or delete channels
* access formal account settings
* access admin team management
* create formal members
* modify formal member information
* modify positions or roles

Never grant permissions based on a position such as `captain`.

A user with:

```js
role: "member",
positions: ["captain"]
```

is still not an admin.

---

## 6. Team positions

A formal team member may have multiple positions.

Supported position values:

```js
const POSITION_NAMES = {
  captain: "队长",
  commander: "指挥",
  entry: "突破手",
  sniper: "狙击手",
  support: "辅助",
  rifler: "步枪手",
  freeman: "自由人",
  backup: "替补",
  member: "队员",
};
```

Example:

```json
{
  "role": "admin",
  "positions": ["captain", "sniper"],
  "positionNames": ["队长", "狙击手"]
}
```

The authoritative multi-position storage is:

```text
user_positions
```

Do not treat the legacy `users.position` column as the source of truth.

Do not remove the legacy column until all compatibility code has been reviewed and a dedicated migration task explicitly approves its removal.

Position updates must:

* validate that the input is an array
* reject unknown values
* remove duplicates
* use a database transaction
* update `user_positions`
* never change `users.role`
* keep at least one position when required by the current API rules

---

## 7. Formal member authentication

Formal users are stored in SQLite.

Formal login uses:

* normalized game nickname
* password hash
* database session
* HttpOnly session cookie

Nickname fields must stay synchronized:

```text
username
username_key
display_name
```

Nickname normalization must:

* check the value type first
* apply Unicode NFKC normalization
* trim leading and trailing whitespace
* use case-insensitive comparison through the normalized key
* reject duplicates
* reject reserved names
* never call `.trim()` or `.normalize()` directly on undefined

Never store plaintext passwords.

Use existing password hashing and verification functions from `auth-utils.js`.

Do not create a second password implementation.

---

## 8. Guest authentication

Guests are temporary identities and must not be inserted into:

```text
users
sessions
user_positions
```

Guest authentication uses:

* random UUID
* signed HttpOnly cookie
* HMAC-SHA256
* environment variable `GUEST_SESSION_SECRET`
* expiration validation
* signature validation

Expected public guest structure:

```json
{
  "id": "guest:UUID",
  "nickname": "临时昵称",
  "displayName": "临时昵称",
  "role": "guest",
  "isAdmin": false,
  "isCaptain": false,
  "isGuest": true,
  "positions": [],
  "positionNames": [],
  "position": "guest",
  "positionName": "访客"
}
```

A malformed, expired, or modified guest cookie must be treated as unauthenticated and must not cause a server 500 response.

Guest login must reject:

* empty or non-string nicknames
* nicknames outside the accepted length
* reserved names
* names matching formal members
* malformed request bodies

Formal and guest identities must be mutually exclusive.

When formal login succeeds, clear the old guest cookie.

When guest login succeeds, clear the old formal session and formal cookie.

Logout must safely clear both identity types.

---

## 9. Authentication middleware

Maintain clear permission middleware.

Preferred responsibilities:

### `requireAuthenticated`

Allows:

```text
admin
member
guest
```

Used for:

* permitted channel reads
* joining voice channels
* obtaining LiveKit tokens
* basic chat
* public team member information

### `requireRegistered`

Allows:

```text
admin
member
```

Used for:

* formal account settings
* channel creation
* channel modification
* channel deletion

### `requireAdmin`

Allows:

```text
admin
```

Used for:

* formal member creation
* member editing
* position management
* password reset
* member deletion
* admin management pages

Existing middleware such as `requireMember` and `requireCaptain` may remain temporarily for compatibility.

Before replacing or deleting middleware, search every call site and migrate safely.

All permission failures must return JSON with an appropriate HTTP status.

---

## 10. LiveKit rules

LiveKit tokens must be issued only by the backend after verifying the current identity.

Do not trust roles, positions, or user IDs sent by the frontend.

Formal member identity should use the existing stable formal-user strategy.

Guest identity must use:

```text
guest:UUID
```

Do not use the guest nickname as the unique LiveKit identity.

Guest LiveKit metadata should indicate:

```json
{
  "role": "guest",
  "isGuest": true,
  "positions": []
}
```

Do not change the existing LiveKit architecture unless the task specifically requires it.

---

## 11. Frontend user state

`App.jsx` owns the authenticated `currentUser` state.

Do not create an unrelated second authenticated-user state in another component.

Account and member components should update the central user state through a callback such as:

```js
onUserUpdated(updatedUser)
```

or by re-fetching:

```text
GET /api/auth/me
```

Updating account information must immediately update:

* the left-bottom account display
* nickname
* position labels
* visible permission controls

Do not replay the login welcome animation after ordinary account edits unless explicitly requested.

---

## 12. Login screen rules

File:

```text
client/src/components/auth/LoginScreen.jsx
```

Never create nested forms.

The login card must use either:

* one form whose submit handler changes by mode, or
* two separate sibling forms

It must never contain:

```jsx
<form>
  <form>
  </form>
</form>
```

The validated current approach is:

* guest panel closed → submit with `handleMemberLogin`
* guest panel open → submit with `handleGuestLogin`

Button rules:

* open guest panel: `type="button"`
* cancel guest mode: `type="button"`
* formal login: `type="submit"`
* guest enter: `type="submit"`

All submit handlers must call:

```js
event.preventDefault();
```

Do not reintroduce the bug that navigates the browser to:

```text
/?
```

Preserve:

* formal member login
* guest login
* loading states
* error states
* `onLogin(data.user)`
* current visual design

---

## 13. UI and style

Maintain the existing NovaSpeak visual language:

* dark background
* cyan/teal accents
* lightweight gaming interface
* clear Chinese labels
* readable text
* restrained animations

Avoid excessive blur on important text.

Do not reduce text clarity through animated blur filters or large transform scaling.

Public-facing UI text and errors should be in Chinese unless the task explicitly requests another language.

Do not redesign the entire application while implementing a small feature.

---

## 14. Database rules

Database file:

```text
server/data/novaspeak.db
```

Use parameterized SQL.

Use transactions for related multi-step writes, including:

* nickname synchronization
* multi-position replacement
* account deletion with related data
* migrations

Before schema migrations:

1. inspect the current schema
2. back up the database
3. make migrations repeatable where possible
4. preserve existing user data
5. report exactly what changed

Do not use the production database for destructive automated tests.

Use one of:

* a database copy
* a temporary test database
* transaction rollback
* disposable test records that are fully removed

---

## 15. Secrets and ignored files

Never commit or print secret values.

Do not commit:

```text
server/.env
node_modules/
server/node_modules/
client/node_modules/
server/data/*.db-wal
server/data/*.db-shm
```

Do not reveal:

```text
GUEST_SESSION_SECRET
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
session tokens
password hashes
cookies
```

`.env.example` may include placeholder names but never real values.

Before committing, inspect:

```powershell
git status
git diff --cached
```

Do not stage unrelated runtime files.

Do not commit `client/dist` unless the repository already intentionally tracks production build output.

---

## 16. Git rules

Before coding:

```powershell
git status
git branch --show-current
git remote -v
```

Do not assume the current branch name.

Do not infer the PR target branch without checking available metadata.

Never:

* force push
* rewrite shared history without explicit approval
* push directly to `main` unless explicitly instructed
* overwrite unrelated uncommitted user changes
* commit runtime database files
* commit `.env`
* commit `node_modules`

When merge conflicts occur:

* inspect both sides
* manually preserve all required functionality
* remove all conflict markers
* run builds before committing
* do not blindly choose all “ours” or all “theirs”

Check for conflict markers using a PowerShell-compatible command in user instructions:

```powershell
Select-String `
  -Path .\client\src\components\auth\LoginScreen.jsx `
  -Pattern '<<<<<<<|=======|>>>>>>>'
```

If the Codex environment cannot access GitHub:

* do not claim fetch, push, or PR completion
* report the network limitation
* provide exact PowerShell steps for the user
* keep the local commit hash available

---

## 17. Build and test requirements

After frontend changes:

```powershell
cd C:\Users\zkcsk\Desktop\NovaSpeak\client
npm run build
```

After backend changes:

* inspect available scripts in `server/package.json`
* run syntax or test commands
* start the backend when practical
* verify modified endpoints return JSON

Do not finish a task without running relevant checks.

Minimum checks for authentication or permission tasks:

* unauthenticated access
* guest access
* member access
* admin access
* invalid input
* successful input
* JSON response type
* session continuity
* logout behavior
* no secret fields in responses
* frontend production build

When tests require a formal password, do not request or expose the user’s real password.

Use a disposable test account or test database.

Known existing lint failures outside the modified scope may be reported without being fixed, but new lint errors in modified files must be fixed.

---

## 18. API response rules

Successful API responses should use consistent JSON structures such as:

```json
{
  "success": true,
  "user": {}
}
```

Errors should use:

```json
{
  "error": "清晰的中文错误信息"
}
```

Suggested status codes:

```text
400 invalid input
401 unauthenticated or incorrect current password
403 authenticated but insufficient permission
404 resource not found
409 nickname or resource conflict
500 unexpected server error
```

Do not send raw stack traces, SQL statements, secrets, or internal paths to the browser.

Log useful server-side details without logging passwords, cookies, or secret values.

---

## 19. Backward compatibility

Preserve existing working behavior unless the task explicitly changes it.

Current critical functions include:

* formal nickname/password login
* guest temporary login
* `/api/auth/me`
* logout
* multi-position public user data
* admin team management
* channel persistence
* LiveKit token generation
* welcome animation
* frontend production build
* Express serving `client/dist`

When introducing a new data structure, temporarily retain compatibility fields when existing frontend code still uses them.

Example:

```json
{
  "positions": ["captain", "sniper"],
  "positionNames": ["队长", "狙击手"],
  "position": "captain",
  "positionName": "队长"
}
```

Remove compatibility fields only in a dedicated cleanup task after all consumers have migrated.

---

## 20. Definition of done

A task is complete only when:

1. Relevant current code was inspected.
2. The implementation matches the role and permission model.
3. No unrelated features were removed.
4. APIs return JSON.
5. Required security validation exists on the backend.
6. Frontend error and loading states work.
7. Required build or tests pass.
8. No conflict markers remain.
9. No secrets or runtime files are staged.
10. The final report accurately distinguishes:

    * completed work
    * verified work
    * unverified manual checks
    * remaining limitations

---

## 21. Required final report

After completing a task, report:

1. Current branch
2. Files inspected
3. Files modified or added
4. Main implementation decisions
5. API routes added or changed
6. Permission behavior for admin, member, and guest
7. Commands executed
8. Build and test results
9. Existing unrelated warnings or failures
10. Git commit hash, when created
11. Push or PR status
12. Manual verification steps for the user
13. Any unfinished or uncertain parts

Do not respond only with “completed” or “fixed”.

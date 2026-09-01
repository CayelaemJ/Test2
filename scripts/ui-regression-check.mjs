import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const read = (p) => readFileSync(join(root,p),"utf8");
const pages = {
  dashboard: read("public/dashboard.html"),
  admin: read("public/admin.html"),
  users: read("public/users.html"),
};
const nav = read("public/portal-nav-v053.js");
const navCss = read("public/portal-nav-v053.css");
const server = read("src/server.ts");
const snap = read("src/services/snapshotBuilder.ts");
const score = read("src/services/scoreEngine.ts");
const imports = read("src/services/importService.ts");
const failures=[];
const must=(ok,msg)=>{ if(!ok) failures.push(msg); };
const everyPage=(predicate)=>Object.entries(pages).every(([name,src])=>predicate(src,name));

must(existsSync(join(root,"public/portal-nav-v053.js")) && existsSync(join(root,"public/portal-nav-v053.css")), "versioned navigation assets must exist");
must(everyPage(src=>src.includes('/static/portal-nav-v053.css?v=0.5.3') && src.includes('/static/portal-nav-v053.js?v=0.5.3')), "all protected pages must load v0.5.3 versioned navigation assets");
must(everyPage(src=>src.includes('data-portal-build="0.5.3"')), "all protected pages must carry the v0.5.3 build marker");
must(everyPage(src=>!src.includes('class="nav-name"') && !src.includes('class="nav-signout"') && !src.includes('onclick="signOut();return false;"')), "legacy inline username/sign-out navigation must be absent from every protected page");
must(pages.dashboard.includes('id="portal-account"') && pages.admin.includes('id="portal-account"') && pages.users.includes('id="portal-account"'), "all protected pages need the shared account mount");
must(nav.includes("PORTAL_BUILD='0.5.3'") && nav.includes('portal-account-menu') && nav.includes('Portal v${PORTAL_BUILD}') && nav.includes('Sign out'), "account dropdown must contain profile metadata, version and sign out");
must(navCss.includes('.portal-account-menu') && navCss.includes('.portal-account-build'), "account dropdown styling must be present");
must(pages.admin.includes('id="source-tab-sql"') && pages.admin.includes('Database integration'), 'Administration must expose Database integration as a first-class option');
must(pages.admin.includes('Database connection (Direct SQL)') && pages.admin.includes('id="integ-sql-host"'), 'Administration must retain SQL connection fields');
must(pages.admin.includes('body:JSON.stringify(body)') && pages.admin.includes('function integrationDraft()'), 'connection test/save must use the currently entered integration fields');
must(pages.dashboard.includes("countTag.textContent='Data unavailable'") && !pages.dashboard.includes('<span class="card-tag">3,247 chats</span>'), 'live chat UI must not leak the hard-coded 3,247 badge');
must(!pages.dashboard.includes('2,114 employee money problems fixed') && pages.dashboard.includes('id="outcomes-note"') && pages.dashboard.includes("financial ${total===1?'problem':'problems'} resolved"), 'outcomes summary must be calculated from live outcome counts, never hard-coded');
must(!pages.dashboard.includes('58% earn under R15k/mo') && !pages.dashboard.includes('2,114 employee money problems fixed'), 'live dashboard must not contain demo-specific interpretation text outside the explicit demo fixture');
must(!pages.dashboard.includes('>1,182 enrolled<') && pages.dashboard.includes('— enrolled'), 'live filter row must not contain a hard-coded enrolled count');
must(pages.dashboard.includes('w.complete===false || !hasValue(w.score)') && pages.dashboard.includes('Data not loaded') && pages.dashboard.includes('function fmtCount'), 'live KPI/wellness renderers must preserve unavailable state instead of synthetic zero/null values');
must(score.includes('optimiseScore: number | null') && snap.includes('missingFeeds'), 'missing feeds must continue to produce unavailable scores, not synthetic scores');
must(snap.includes('const CORE_FEEDS = [') && !snap.match(/CORE_FEEDS\s*=\s*\[[\s\S]*?chat_sessions/), 'chat must not be part of the 10 core source feeds');
must(pages.dashboard.includes("const value=(v,fallback='—')"), 'month activity strip must not render null/undefined values');
must(pages.users.includes('function renderEmpPick()') && pages.users.includes('renderEmpPick();'), 'Users page must define and invoke the employer picker renderer');
must(pages.users.includes("await Promise.allSettled([loadPartnersDropdown(),loadUsers()])"), 'Users page startup must continue loading user and partner data after employer rendering');
must(pages.users.includes('showUsersLoadError') && pages.users.includes('Could not load users.'), 'Users page must replace indefinite loading states with a visible retryable error');
must(pages.users.includes("const users=await getJson('/api/users')"), 'Users page must fetch the admin user list through the checked JSON helper');

must(pages.admin.includes('function openReset()') && pages.admin.includes('async function doReset()') && pages.admin.includes('/api/admin/reset-all'), 'Administration reset control must have working open/reset handlers');
must(pages.admin.includes('b.revertable') && pages.admin.includes('Could not revert this import'), 'Import history must expose safe revert controls and visible revert failures');
must(server.includes('revertable') && server.includes('reply.code(409)') && imports.includes('batch.reportKey === "employers"'), 'Backend must publish revertability and safely support insert-only employer rollback');
must(server.includes('X-Empower-Portal-Build') && server.includes('no-store, no-cache') && server.includes('version: "0.5.3"'), 'server must expose build identity and disable stale UI caching');
must(pages.admin.includes('System Email &amp; Scheduled Reports') && pages.admin.includes('id="mail-host"') && pages.admin.includes('Send test email'), 'Administration must expose SMTP system email setup');
must(pages.dashboard.includes('function openScheduleReport()') && pages.dashboard.includes('/api/report-schedules') && pages.dashboard.includes('Save schedule'), 'Dashboard Schedule report must open a real scheduling workflow');
must(pages.dashboard.includes('id="pf-employer-filter"') && pages.dashboard.includes('id="pf-select-all"') && pages.dashboard.includes('id="pf-clear-all"') && pages.dashboard.includes('function pfVisibleEmployers()'), 'Portfolio view must provide employer multi-select filtering with Select all/Clear all');
must(pages.dashboard.includes('PORTFOLIO_METRIC_INFO') && pages.dashboard.includes('class="metric-info"') && pages.dashboard.includes('function pfShowMetricTip'), 'Portfolio measures must expose hover/focus information tooltips');
must(pages.dashboard.includes('function pfMoney(v)') && !pages.dashboard.includes("raw:'R '+(totSaving/1e6).toFixed(2)+'m'"), 'Portfolio money KPIs must use scale-aware formatting rather than showing small values as R0.00m');
must(pages.dashboard.includes('Missing measures are shown as unavailable and are not ranked as zero') && pages.dashboard.includes('pf-no-data'), 'Portfolio view must preserve missing-data state instead of converting unavailable metrics to zero');
must(pages.dashboard.includes('id="btn-pf-export"') && pages.dashboard.includes("pfExp.addEventListener('click'"), 'Portfolio Export book action must be wired');
must(server.includes('/api/admin/email-settings') && server.includes('/api/report-schedules/:id/send-now') && server.includes('startReportScheduler(app)'), 'Server must expose SMTP and scheduled report routes and start the scheduler');

must(pages.dashboard.includes('const EMPLOYER_METRIC_INFO = {'), 'Employer metric glossary must be embedded in the dashboard');
must(pages.dashboard.includes('data-metric=\"wellness\"') && pages.dashboard.includes("wireMetricTips(document.getElementById('employer-view'))"), 'Employer view must expose and wire metric information icons');
must(pages.dashboard.includes("infoKey:'takeUp'") && pages.dashboard.includes("infoKey:'engaged'") && pages.dashboard.includes("infoKey:'saving'") && pages.dashboard.includes("infoKey:'rating'"), 'Employer KPI cards must expose metric help');
must(pages.dashboard.includes('funnelEligible') && pages.dashboard.includes('valueMonthly') && pages.dashboard.includes('debtProfile') && pages.dashboard.includes('prescription') && pages.dashboard.includes('riskSignals') && pages.dashboard.includes('opportunities'), 'Employer metric glossary must cover the major dashboard sections');

if(failures.length){ console.error('UI regression check failed:\n- '+failures.join('\n- ')); process.exit(1); }
console.log('UI regression check passed: v0.5.3 navigation, SQL integration, users/import controls, live-data availability and demo-leak safeguards are present.');

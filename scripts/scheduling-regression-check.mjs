import { readFileSync } from 'node:fs';
const read=p=>readFileSync(p,'utf8');
const schema=read('prisma/schema.prisma');
const server=read('src/server.ts');
const scheduler=read('src/services/reportScheduler.ts');
const admin=read('public/admin.html');
const dash=read('public/dashboard.html');
const pkg=JSON.parse(read('package.json'));
const failures=[]; const must=(ok,msg)=>{if(!ok) failures.push(msg)};

must(schema.includes('model SystemEmailConfig') && schema.includes('model ReportSchedule') && schema.includes('model ReportDeliveryLog'), 'Prisma schema must persist SMTP settings, schedules and delivery logs');
must(schema.includes('enum ReportFrequency') && schema.includes('ONCE') && schema.includes('MONTHLY'), 'Report frequency enum must support one-off and recurring schedules');
must(pkg.dependencies?.nodemailer && pkg.dependencies?.luxon, 'Runtime dependencies must include nodemailer and luxon');
must(scheduler.includes('nodemailer.createTransport') && scheduler.includes('transporter.verify()') && scheduler.includes('transporter.sendMail'), 'SMTP transport must support verify and send');
must(scheduler.includes('nextRunFor') && scheduler.includes('WEEKLY') && scheduler.includes('MONTHLY'), 'Scheduler must calculate recurring next-run dates');
must(scheduler.includes('getDashboardPayload(schedule.employerId') && scheduler.includes('schedule.filters'), 'Scheduled emails must rebuild the dashboard using the saved report filters');
must(scheduler.includes('themeForEmployer(schedule.employerId)'), 'Scheduled emails must use the employer channel-partner branding');
must(scheduler.includes('triggeredBy === "scheduled"') && scheduler.includes('nextRunAt: retry'), 'Manual Send now failures must not move the persisted schedule into an automatic retry window');
must(scheduler.includes('updateMany') && scheduler.includes('nextRunAt: { lte: now }'), 'Due schedule claiming must be database-backed to reduce duplicate sends');
must(server.includes('/api/report-schedules/config') && server.includes('/api/report-schedules/:id/send-now'), 'User scheduling API must expose configuration and send-now routes');
must(server.includes('startReportScheduler(app)'), 'Runtime must start the scheduled report checker');
must(admin.includes('System Email &amp; Scheduled Reports') && admin.includes('saveEmailSettings') && admin.includes('testEmailSettings'), 'Admin UI must allow SMTP save and test');
must(dash.includes('openScheduleReport') && dash.includes('schedule-window') && dash.includes('schedule-site') && dash.includes('schedule-income'), 'Dashboard modal must expose report window, region and income filters');
must(dash.includes('schedule-frequency') && dash.includes('schedule-once-date') && dash.includes('schedule-weekday') && dash.includes('schedule-monthday'), 'Dashboard modal must expose one-off, weekly and monthly timing controls');
if(failures.length){console.error('Scheduling regression check failed:\n- '+failures.join('\n- '));process.exit(1)}
console.log('Scheduling regression check passed: SMTP setup, persisted schedules, filter capture and automatic delivery are wired.');

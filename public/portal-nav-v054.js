(function(){
  'use strict';

  const PORTAL_BUILD='0.5.4';
  window.__EMPOWER_PORTAL_BUILD__=PORTAL_BUILD;
  console.info('[empower-fin Dashboard Portal] UI build', PORTAL_BUILD);

  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const initials = (name) => String(name || 'User').trim().split(/\s+/).filter(Boolean).map(p=>p[0]).slice(0,2).join('').toUpperCase() || 'U';
  const roleLabel = (role) => ({ADMIN:'Administrator',EMPLOYER_VIEW:'Employer access',PORTFOLIO_VIEW:'Portfolio access'}[role] || String(role || 'User').replaceAll('_',' '));

  async function signOut(){
    try{ await fetch('/api/auth/logout',{method:'POST'}); }catch(_){ /* redirect anyway */ }
    location.href='/login';
  }

  async function deactivateSelf(){
    const overlay=document.createElement('div');
    overlay.className='portal-modal-overlay';
    overlay.innerHTML=`
      <div class="portal-modal" role="dialog" aria-modal="true" aria-label="Deactivate my account">
        <h3>Deactivate your account?</h3>
        <p>You'll be signed out immediately and won't be able to sign back in. An administrator can see this in Past users and reactivate it for you.</p>
        <label class="portal-modal-label">Reason (optional)</label>
        <textarea class="portal-modal-textarea" rows="3" placeholder="e.g. leaving the company, no longer need access…"></textarea>
        <div class="portal-modal-actions">
          <button type="button" class="portal-modal-cancel">Cancel</button>
          <button type="button" class="portal-modal-confirm">Deactivate my account</button>
        </div>
        <div class="portal-modal-error" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    const close=()=>overlay.remove();
    overlay.addEventListener('click',ev=>{ if(ev.target===overlay) close(); });
    overlay.querySelector('.portal-modal-cancel').addEventListener('click',close);
    overlay.querySelector('.portal-modal-confirm').addEventListener('click',async ()=>{
      const btn=overlay.querySelector('.portal-modal-confirm');
      const errEl=overlay.querySelector('.portal-modal-error');
      const reason=overlay.querySelector('.portal-modal-textarea').value.trim();
      btn.disabled=true; btn.textContent='Deactivating…';
      try{
        const r=await fetch('/api/users/me/deactivate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});
        if(!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.error||'Could not deactivate the account'); }
        location.href='/login?deactivated=1';
      }catch(e){
        errEl.hidden=false; errEl.textContent=e.message;
        btn.disabled=false; btn.textContent='Deactivate my account';
      }
    });
  }

  function closeAll(except){
    document.querySelectorAll('.portal-account-menu.is-open').forEach(menu=>{
      if(menu===except) return;
      menu.classList.remove('is-open');
      const trigger=menu.parentElement?.querySelector('.portal-account-trigger');
      if(trigger) trigger.setAttribute('aria-expanded','false');
    });
  }

  function render(options){
    const me=options?.me;
    if(!me) return;
    const nav=document.querySelector(options.navSelector || '#portal-nav');
    const account=document.querySelector(options.accountSelector || '#portal-account');
    const active=options.active || '';

    const destinations=[];
    if(me.modules?.dashboard) destinations.push({key:'dashboard',href:'/dashboard',label:'Dashboard'});
    if(me.modules?.admin) destinations.push({key:'admin',href:'/admin',label:'Administration'});
    if(me.modules?.users) destinations.push({key:'users',href:'/users',label:'Users'});

    if(nav){
      const links=destinations
        .filter(item => item.key!=='dashboard' || options.includeDashboard !== false)
        .map(item=>`<a class="portal-nav-link ${active===item.key?'is-active':''}" href="${item.href}">${item.label}</a>`);
      nav.className='portal-primary-nav';
      nav.innerHTML=links.join('');
    }

    if(account){
      const menuId='portal-account-menu-'+Math.random().toString(36).slice(2,8);
      account.className='portal-account';
      account.innerHTML=`
        <button class="portal-account-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" title="Account menu">
          <span class="portal-account-avatar" aria-hidden="true">${esc(initials(me.name))}</span>
          <svg class="portal-account-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="portal-account-menu" id="${menuId}" role="menu">
          <div class="portal-account-header">
            <div class="portal-account-name">${esc(me.name || 'User')}</div>
            ${me.email?`<div class="portal-account-email">${esc(me.email)}</div>`:''}
            <div class="portal-account-role">${esc(roleLabel(me.role))}</div>
            <div class="portal-account-build">Portal v${PORTAL_BUILD}</div>
          </div>
          <div class="portal-mobile-links">
            ${destinations.map(item=>`<a class="portal-mobile-link ${active===item.key?'is-active':''}" href="${item.href}">${item.label}</a>`).join('')}
          </div>
          <button class="portal-menu-action portal-signout" type="button" role="menuitem" data-portal-signout>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19H10M14.5 8 18.5 12l-4 4M18 12H9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Sign out
          </button>
          <button class="portal-menu-action portal-deactivate" type="button" role="menuitem" data-portal-deactivate>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            Deactivate my account
          </button>
        </div>`;

      const trigger=account.querySelector('.portal-account-trigger');
      const menu=account.querySelector('.portal-account-menu');
      trigger?.addEventListener('click',ev=>{
        ev.stopPropagation();
        const open=!menu.classList.contains('is-open');
        closeAll(open?menu:null);
        menu.classList.toggle('is-open',open);
        trigger.setAttribute('aria-expanded',String(open));
      });
      menu?.addEventListener('click',ev=>ev.stopPropagation());
      account.querySelector('[data-portal-signout]')?.addEventListener('click',signOut);
      account.querySelector('[data-portal-deactivate]')?.addEventListener('click',()=>{ closeAll(); deactivateSelf(); });
    }
  }

  document.addEventListener('click',()=>closeAll());
  document.addEventListener('keydown',ev=>{ if(ev.key==='Escape') closeAll(); });
  window.EmpowerPortalNav={render,signOut,deactivateSelf};
})();

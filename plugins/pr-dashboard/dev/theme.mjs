let dark = false;
function apply() {
  document.body.classList.toggle('dark', dark);
  for (const frame of document.querySelectorAll('main iframe')) {
    const root = frame.contentDocument?.documentElement;
    if (!root) continue;
    const tokens = dark ? { '--panel-bg':'#1b1e24','--surface':'#1b1e24','--text-primary':'#ebedf0','--text-secondary':'#a7b0bd','--border-default':'#353b46' } : { '--panel-bg':'#ffffff','--surface':'#ffffff','--text-primary':'#1c2530','--text-secondary':'#66717e','--border-default':'#e1e6eb' };
    for (const [key,value] of Object.entries(tokens)) root.style.setProperty(key,value);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }
}
document.querySelector('#theme').addEventListener('click', () => { dark = !dark; apply(); });
for (const frame of document.querySelectorAll('main iframe')) frame.addEventListener('load', apply);

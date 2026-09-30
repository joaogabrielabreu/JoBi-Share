import { $, $$, bindCodeInput, normalizeCode, store, toast } from './util.js';
import { getConfig } from './config.js';
import { HostSession } from './host.js';
import { ViewerSession } from './viewer.js';

const VIEWS = ['home', 'host', 'viewer'];
let session = null;

function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  document.body.dataset.view = view;
  window.scrollTo(0, 0);
}

function currentName() {
  return $('#home-name').value.trim().slice(0, 32);
}

function goHome() {
  session?.destroy?.();
  session = null;
  history.replaceState(null, '', '/');
  document.title = 'Janela';
  show('home');
}

async function startHost() {
  const config = await getConfig();
  session?.destroy?.();
  session = new HostSession({ config, name: currentName() || 'Anfitrião', onExit: goHome });
  show('host');
  session.enter();
}

async function startViewer(code, autoJoin, name = currentName()) {
  const config = await getConfig();
  session?.destroy?.();
  session = new ViewerSession({
    config,
    onExit: (action) => (action?.retry ? startViewer(action.retry, true, action.name) : goHome()),
  });
  show('viewer');
  session.enter({ code, name, autoJoin });
}

function setupHome() {
  const nameInput = $('#home-name');
  nameInput.value = store.get('janela.name', '');
  nameInput.addEventListener('input', () => store.set('janela.name', nameInput.value.trim()));

  const canCapture = !!navigator.mediaDevices?.getDisplayMedia && window.isSecureContext;
  const hostBtn = $('#btn-host');
  if (!canCapture) {
    hostBtn.disabled = true;
    const note = $('#host-unsupported');
    note.hidden = false;
    note.textContent = !window.isSecureContext
      ? `Para transmitir, abra http://localhost:${location.port || 80} no computador que roda o Janela.`
      : 'Este navegador não permite capturar a tela (celulares não suportam). Use Chrome, Edge ou Firefox no computador.';
  }
  hostBtn.addEventListener('click', startHost);

  const codeInput = $('#join-code');
  bindCodeInput(codeInput);
  $('#form-join').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = normalizeCode(codeInput.value);
    if (code.length !== 6) {
      codeInput.classList.add('shake');
      setTimeout(() => codeInput.classList.remove('shake'), 500);
      codeInput.focus();
      toast('O código tem 6 caracteres (ex.: K7M-2QX).', { kind: 'warn' });
      return;
    }
    startViewer(code, true);
  });
}

function setupSecurityDialog() {
  const dlg = $('#dlg-security');
  for (const b of $$('[data-open-security]')) b.addEventListener('click', () => dlg.showModal());
  $('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });
}

setupHome();
setupSecurityDialog();
getConfig(); // pré-carrega

const code = normalizeCode(new URLSearchParams(location.search).get('s'));
if (code) startViewer(code, false, store.get('janela.name', ''));
else show('home');

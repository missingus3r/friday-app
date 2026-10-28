// Arma mobile/www a partir de la interfaz de escritorio (../renderer) más el puente del celular.
// La interfaz no se duplica: se copia en cada build.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer');
const OUT = path.join(__dirname, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  if (f !== 'index.html') fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
fs.copyFileSync(path.join(__dirname, 'src', 'bridge.js'), path.join(OUT, 'bridge.js'));

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
// En el celular el gateway es un link de ngrok (https/wss) que cambia: se habilita cualquier destino.
html = html.replace(/connect-src [^;"]+/, 'connect-src * ws: wss:');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
html = html.replace('<script src="ui.js"></script>', '<script src="bridge.js"></script>\n  <script src="ui.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('www listo:', fs.readdirSync(OUT).join(', '));

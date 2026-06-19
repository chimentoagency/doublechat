const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

fs.mkdirSync('certs', { recursive: true });

const nets = os.networkInterfaces();
const ips = Object.values(nets)
  .flat()
  .filter((n) => n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);

const domains = ['localhost', '127.0.0.1', ...ips];
console.log('Generating certs for:', domains.join(', '));

try {
  execSync(
    `mkcert -cert-file certs/cert.pem -key-file certs/key.pem ${domains.join(' ')}`,
    { stdio: 'inherit' }
  );
  console.log('\nCertificates saved to certs/');
} catch {
  console.error('\nmkcert not found. Install it from https://github.com/FiloSottile/mkcert');
  process.exit(1);
}

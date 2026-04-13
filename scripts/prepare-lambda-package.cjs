// Strips K8s-only and heavy dependencies from package.json for Lambda packaging.
// Called by scripts/deploy-lambda.sh during CloudFormation deployment.

const fs = require('fs');
const pkgPath = process.argv[2];
if (!pkgPath) {
  console.error('Usage: node prepare-lambda-package.cjs <path-to-package.json>');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
delete pkg.dependencies['@kubernetes/client-node'];
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

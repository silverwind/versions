node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

deps: node_modules

lint: node_modules
	npx eslint --color .

test: node_modules lint build
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color

unittest: node_modules
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --color --watchAll


.PHONY: build
build: node_modules
# workaround for https://github.com/evanw/esbuild/issues/1921
	npx esbuild --log-level=warning --platform=node --target=node14 --format=esm --bundle --minify --outdir=bin --legal-comments=none --banner:js="import {createRequire} from 'module';const require = createRequire(import.meta.url);" ./versions.js
	jq -r tostring package.json > bin/package.json
	chmod +x bin/versions.js

publish: node_modules
	git push -u --tags origin master
	npm publish

update: node_modules
	npx updates -cu
	rm package-lock.json
	npm install
	@touch node_modules

patch: node_modules test
	node versions -Cc 'make build' patch
	@$(MAKE) --no-print-directory publish

minor: node_modules test
	node versions -Cc 'make build' minor
	@$(MAKE) --no-print-directory publish

major: node_modules test
	node versions -Cc 'make build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major

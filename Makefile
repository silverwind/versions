node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

deps: node_modules

lint: node_modules
	npx eslint --color .

test: node_modules lint build
	npx vitest

.PHONY: build
build: node_modules
# workaround for https://github.com/evanw/esbuild/issues/1921
	npx esbuild --log-level=warning --platform=node --target=node14 --format=esm --bundle --minify --outdir=bin --legal-comments=none --banner:js="import {createRequire} from 'module';const require = createRequire(import.meta.url);" ./versions.js
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
	node bin/versions.js -c 'make build' patch package.json package-lock.json
	@$(MAKE) --no-print-directory publish

minor: node_modules test
	node bin/versions.js -c 'make build' minor package.json package-lock.json
	@$(MAKE) --no-print-directory publish

major: node_modules test
	node bin/versions.js -c 'make build' major package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major

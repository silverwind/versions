lint:
	yarn -s run eslint --color .

test: lint build
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn -s run jest --color

unittest: node_modules
	NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn -s run jest --color --watchAll

build:
	yarn -s run ncc build versions.js -q -m --no-source-map-register -o .
	@mv index.js versions.cjs
	@rm -rf versions
	@chmod +x versions.cjs

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update: node_modules
	yarn -s run updates -cu
	@rm yarn.lock
	@yarn -s
	@touch node_modules

patch: test
	node versions -Cc 'make build' patch
	@$(MAKE) --no-print-directory publish

minor: test
	node versions -Cc 'make build' minor
	@$(MAKE) --no-print-directory publish

major: test
	node versions -Cc 'make build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest build publish deps update patch minor major

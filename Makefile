lint:
	yarn -s run eslint --color .

test: lint build
	yarn -s run jest --color

build:
	yarn -s run ncc build versions.js -o . -q -m --no-source-map-register
	@mv index.js versions

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

.PHONY: lint test build publish deps update patch minor major

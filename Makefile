test:
	yarn -s run eslint --color .
	@$(MAKE) --no-print-directory bundle
	yarn -s run jest --color

bundle:
	yarn -s run ncc build versions.js -o . -q -m --no-source-map-register
	@mv index.js versions

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update: bundle
	yarn -s run updates -cu
	@$(MAKE) --no-print-directory deps

patch: test
	node versions -Cc 'make bundle' patch
	@$(MAKE) --no-print-directory publish

minor: test
	node versions -Cc 'make bundle' minor
	@$(MAKE) --no-print-directory publish

major: test
	node versions -Cc 'make bundle' major
	@$(MAKE) --no-print-directory publish

.PHONY: test bundle publish deps update patch minor major

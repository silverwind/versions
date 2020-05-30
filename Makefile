deps:
	yarn

test:
	yarn -s run eslint --color --quiet *.js
	$(MAKE) rollup
	yarn -s run jest --color

rollup:
	yarn -s run rollup --silent --compact -c rollup.config.js

publish:
	git push -u --tags origin master
	npm publish

update:
	yarn -s run updates -u
	rm -rf node_modules
	$(MAKE) deps

patch: test
	yarn -s run versions -Cc 'make rollup' patch
	$(MAKE) publish

minor: test
	yarn -s run versions -Cc 'make rollup' minor
	$(MAKE) publish

major: test
	yarn -s run versions -Cc 'make rollup' major
	$(MAKE) publish


.PHONY: deps test rollup publish update patch minor major

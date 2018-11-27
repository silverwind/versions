test:
	npx eslint --color --quiet *.js

publish:
	git push -u --tags origin master
	npm publish

update:
	npx updates -u
	rm -rf node_modules
	npm i --no-package-lock

patch:
	$(MAKE) test
	node ver.js patch
	$(MAKE) publish

minor:
	$(MAKE) test
	node ver.js minor
	$(MAKE) publish

major:
	$(MAKE) test
	node ver.js major
	$(MAKE) publish


.PHONY: test publish update patch minor major

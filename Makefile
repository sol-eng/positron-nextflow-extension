EDITOR_CLI ?= $(shell command -v positron || echo /Applications/Positron.app/Contents/Resources/app/bin/code)

all: clean package

clean:
	rm -rf build

server:
	make -C ../language-server

compile:
	npm run compile

package:
	npm run package

test: compile
	"$(EDITOR_CLI)" --extensionDevelopmentPath=$(PWD)/build

install: all
	"$(EDITOR_CLI)" --install-extension build/positron-nextflow.vsix

# drive the extension in Positron against test-e2e/pipeline (see test-e2e/run.sh)
e2e: compile
	test-e2e/run.sh

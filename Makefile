NODE ?= node

.PHONY: install uninstall

install:
	@$(NODE) scripts/manage-install.mjs install

uninstall:
	@$(NODE) scripts/manage-install.mjs uninstall

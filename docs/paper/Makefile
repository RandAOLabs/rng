.PHONY: all setup clean compile

# Default target
all: setup compile

# Setup LaTeX environment on macOS/Linux
setup:
	@echo "Setting up LaTeX environment..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		if ! command -v brew >/dev/null 2>&1; then \
			echo "Installing Homebrew..."; \
			/bin/bash -c "$$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; \
		fi; \
		if ! command -v pdflatex >/dev/null 2>&1; then \
			echo "Installing MacTeX..."; \
			brew install mactex; \
		fi; \
	elif [ "$$(uname)" = "Linux" ]; then \
		if ! command -v pdflatex >/dev/null 2>&1; then \
			if command -v apt-get >/dev/null 2>&1; then \
				echo "Installing texlive on Ubuntu/Debian..."; \
				sudo apt-get update && sudo apt-get install -y texlive-full; \
			elif command -v dnf >/dev/null 2>&1; then \
				echo "Installing texlive on Fedora..."; \
				sudo dnf install -y texlive-scheme-full; \
			elif command -v pacman >/dev/null 2>&1; then \
				echo "Installing texlive on Arch Linux..."; \
				sudo pacman -Sy texlive-most; \
			else \
				echo "Error: Unsupported Linux distribution. Please install TeX Live manually."; \
				exit 1; \
			fi; \
		fi; \
	else \
		echo "Error: Unsupported operating system. This setup script supports macOS and Linux."; \
		exit 1; \
	fi
	@echo "Setup complete!"

# Compile the LaTeX document
compile:
	@echo "Compiling LaTeX document..."
	pdflatex randao.tex
	bibtex randao
	pdflatex randao.tex
	pdflatex randao.tex
	@echo "Compilation complete!"

# Clean auxiliary files
clean:
	@echo "Cleaning auxiliary files..."
	rm -f *.aux *.log *.bbl *.blg *.out *.toc *.lof *.lot
	@echo "Clean complete!"

# Help target
help:
	@echo "Available targets:"
	@echo "  make setup    - Install LaTeX and dependencies (supports macOS and Linux)"
	@echo "  make compile  - Compile the LaTeX document"
	@echo "  make clean    - Remove auxiliary files"
	@echo "  make all      - Run setup and compile"
	@echo "  make help     - Show this help message"

# Installing LaTeX

## Prerequisites

1. **LaTeX Distribution**
   - Install MacTeX (on macOS):
     ```bash
     brew install mactex
     ```
     > Note: The MacTeX installation can take a surprisingly long time (10+ minutes) due to its large size. This is normal.
   - For other operating systems:
     - Windows: Install [MiKTeX](https://miktex.org/download)
     - Linux: Install TeXLive (`sudo apt-get install texlive-full` for Ubuntu/Debian)

2. **Text Editor/IDE**
   - Any LaTeX-compatible editor (VS Code, TeXmaker, TeXstudio, etc.)
   - For VS Code users:
     1. Install the LaTeX Workshop extension:
        - Extension ID: `James-Yu.latex-workshop`
        - Direct link: https://open-vsx.org/extension/James-Yu/latex-workshop
     2. Restart VS Code after installation

3. **Verify Installation**
   - Ensure LaTeX is properly installed:
     ```bash
     pdflatex --version
     ```
   - You should see version information for the TeX distribution

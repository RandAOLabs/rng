# Usage Guide

This guide explains how to work with and compile the RandAO Whitepaper.

## Compiling the Document

1. **Basic Compilation**
   ```bash
   pdflatex randao.tex
   ```
   This will generate `randao.pdf` in the same directory.

2. **Complete Compilation (for references and citations)**
   ```bash
   pdflatex randao.tex
   bibtex randao
   pdflatex randao.tex
   pdflatex randao.tex
   ```
# Rendered diagrams

SVG copies of the Mermaid diagrams in [`../ARCHITECTURE.md`](../ARCHITECTURE.md), which is the source. Regenerate after editing it:

```bash
npx -y @mermaid-js/mermaid-cli@11.4.2 -i docs/ARCHITECTURE.md -o /tmp/arch.md -e svg
# then copy /tmp/arch-1.svg .. arch-6.svg to: system-map, any-honest-round, fast-request, fair-session, governance, money-flows
```

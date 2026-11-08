# Pull Request: RNG Protocol UML Diagrams

## Description
Briefly describe the changes made to the UML diagrams.

## Changes Made
- [ ] Updated existing diagram(s)
- [ ] Added new diagram(s)  
- [ ] Modified style guide
- [ ] Updated documentation

## Developer Checklist

### ✅ Required - Before submitting this PR:

- [ ] **Run Docker command locally:** `docker compose up --build`
- [ ] **Verify all diagrams compile without errors (0 failures in output)**
- [ ] **Commit the generated diagram images** from `diagram-images/` directory
- [ ] **Include both `.puml` source files AND generated `.png` files in this PR**
- [ ] **Push both source diagrams AND generated images** to your PR branch

> ⚠️ **Important:** You MUST commit and push the generated PNG files. The GitHub Actions workflow will verify that all diagrams compile and that PNG files are present in your PR.

### 📋 Validation (will be checked by GitHub Actions):

- [ ] All `.puml` files compile successfully
- [ ] Generated `.png` files are present in the PR
- [ ] Corporate styling is applied correctly
- [ ] Directory structure is maintained

## Files Modified

List the specific diagram files that were changed:
- `diagram-definitions/[category]/[filename].puml`

## Testing

- [ ] Tested locally with `docker-compose up --build`
- [ ] Verified PNG output quality and styling
- [ ] Confirmed all includes and references work correctly

---

**Note:** The GitHub Actions workflow will automatically validate that all diagrams compile and that you've included the generated PNG files. PRs will be blocked if validation fails.
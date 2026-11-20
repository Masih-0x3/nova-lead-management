## Summary

<!-- What does this change and why? Link related issues (e.g. Closes #123). -->

## Test plan

<!-- How was this verified? Commands run, lanes exercised, screenshots for UI changes. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run release:check`

## Checklist

- [ ] Tests added or updated for behavior changes
- [ ] Docs (and `CHANGELOG.md` where relevant) updated
- [ ] No historical `supabase/migrations/*.sql` files edited (new migrations only)
- [ ] New code uses "Nova Lead Management" / `NOVA_*` naming (no nosite/NoSite)
- [ ] No secrets, `.env*` files, or real customer data committed; fixtures are synthetic

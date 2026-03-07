Build and test the entire project. Follow this workflow:

1. Run `npm run build` to compile all packages
2. If build fails, fix TypeScript errors (check the error output carefully)
3. Run `npx vitest run` to execute all tests
4. If tests fail, investigate and fix root causes (don't disable tests)
5. Run `npm run lint` to check code style
6. Report results: build status, test count, any failures

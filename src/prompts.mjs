export const DEFAULT_PROMPTS = {
  discuss: '',
  fix: [
    'Check the current state of pull request {url} ({reference}: "{title}").',
    'This workspace starts from the pull request head (`{headBranch}`) on a new local branch.',
    'Use `gh pr view {number} --repo {repository} --comments`, `gh pr checks {number} --repo {repository}` and the unresolved review threads to find what is blocking it: failing checks, merge conflicts with `{baseBranch}`, requested changes and unanswered review comments.',
    'Then report what needs fixing and propose the concrete fix for each item.',
    'Do not commit or push until I approve. When I do, push to the pull request branch with `git push origin HEAD:{headBranch}`.'
  ].join('\n\n')
};

/**
 * Replace the placeholders in a prompt template with the pull request values, leaving unknown ones as they are.
 */

export function fillPrompt(template, pullRequest) {
  const values = {
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    number: pullRequest.number,
    reference: `${pullRequest.repository}#${pullRequest.number}`,
    repository: pullRequest.repository,
    title: pullRequest.title,
    url: pullRequest.url
  };

  return template.replace(/\{(\w+)\}/g, (placeholder, key) => (Object.hasOwn(values, key) ? String(values[key]) : placeholder));
}

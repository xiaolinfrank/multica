import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { TestApiClient } from './fixtures';

test.use({ viewport: { width: 1600, height: 1050 }, locale: 'en-US', timezoneId: 'Asia/Shanghai',
  contextOptions: { reducedMotion: 'reduce' }, screenshot: 'only-on-failure', trace: 'retain-on-failure' });

test('repairs an unbound execution item through its plan details without losing the destination', async ({ page }, info) => {
  test.setTimeout(120_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-recovery-${run}@multica.ai`, 'Recovery path reviewer');
  let owns = false;
  try {
    const ws = await api.createWorkspace(`Recovery paths ${run}`, `e2e-recovery-${run}`); owns = true;
    await api.markUserOnboarded();
    await api.updateCockpitBoard({ title: 'Programme recovery workbench' });
    const project = await api.createProject('Recovery programme');
    const module = await api.createModule(project.id, 'Evidence stream');
    const dates = { start_date: '2026-10-10', end_date: '2026-12-31' };
    const l1 = await api.createCockpitNode({ code: 'REC-L1', name: 'Programme plan', project_id: project.id, ...dates });
    const l2 = await api.createCockpitNode({ code: 'REC-L2', name: 'Unconfigured evidence stream', parent_id: l1.id, ...dates });
    const l3 = await api.createCockpitNode({ code: 'REC-L3', name: 'Collect acceptance evidence', parent_id: l2.id, ...dates });
    const token = api.getToken(); if (!token) throw new Error('Recovery fixture has no token');
    await page.addInitScript(value => {
      localStorage.setItem('multica_token', value); localStorage.setItem('multica:chat:isOpen', 'false');
      document.cookie = 'multica-locale=en; path=/';
    }, token);
    const cockpit = `/${ws.slug}/cockpit`;
    const taskPath = `${cockpit}?node=${l3.id}`;
    const detailsPath = `${taskPath}&node_view=details`;
    const mutationRequests: string[] = [];
    page.on('request', request => {
      if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/cockpit/nodes/')) {
        mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    await page.goto(taskPath, { waitUntil: 'domcontentloaded' });
    const tasks = page.getByRole('region', { name: 'L3 issues', exact: true });
    const binding = page.getByRole('region', { name: 'Project and module binding', exact: true });
    await expect(tasks.getByRole('button', { name: 'Create issue', exact: true })).toBeDisabled();
    const recovery = tasks.getByRole('link', { name: 'Open plan details and binding', exact: true });
    await expect(recovery).toHaveAttribute('href', detailsPath);
    await expect(tasks.getByText('Bind a project and module on parent rows before creating or assigning issues here.', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('recovery-l3-entry.png'), animations: 'disabled' });
    await recovery.click();
    await expect(page).toHaveURL(detailsPath);
    await expect(page.getByRole('tab', { name: 'Plan details', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(binding).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Plan details', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(binding.getByRole('button', { name: 'Configure parent binding', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(page).toHaveURL(`${taskPath}&node_view=tasks`);
    await page.goBack();
    await expect(page).toHaveURL(detailsPath);
    await expect(page.getByRole('tab', { name: 'Plan details', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(mutationRequests).toEqual([]);

    await binding.getByRole('button', { name: 'Configure parent binding', exact: true }).click();
    await expect(page).toHaveURL(`${cockpit}?node=${l2.id}`);
    await binding.getByRole('button', { name: 'Configure binding', exact: true }).click();
    await expect(binding.getByLabel('Project', { exact: true })).toContainText(project.title);
    await binding.getByLabel('Module', { exact: true }).click();
    await page.getByRole('option', { name: module.title, exact: true }).click();
    await binding.getByRole('button', { name: 'Save binding', exact: true }).click();
    await expect(binding.getByText('Mapped module row', { exact: true })).toBeVisible();
    expect((await api.getCockpitBoard()).nodes.find(node => node.id === l2.id)).toMatchObject({ project_id: project.id, module_id: module.id });
    await page.goBack();
    await expect(page).toHaveURL(detailsPath);
    await expect(binding).toContainText(`${project.title} / ${module.title}`);
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(tasks.getByRole('button', { name: 'Create issue', exact: true })).toBeEnabled();
    await expect(tasks.getByRole('link', { name: 'Open plan details and binding', exact: true })).toHaveCount(0);
    await tasks.getByRole('button', { name: 'Create issue', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create issue', exact: true });
    await dialog.getByLabel('Issue title', { exact: true }).fill('Evidence from the repaired execution item');
    const created = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/cockpit/nodes/${l3.id}/tasks`);
    await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
    const response = await created; expect(response.status()).toBe(200);
    const issue = await response.json();
    expect(issue).toMatchObject({ project_id: project.id, module_id: module.id, primary_node_id: l3.id,
      status: 'backlog', assignee_type: 'member', assignee_id: auth.user.id });
    await expect(dialog).not.toBeVisible();
    await expect(tasks.getByRole('link', { name: new RegExp(issue.title) })).toBeVisible();
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    await page.screenshot({ path: info.outputPath('recovery-l3-complete.png'), animations: 'disabled' });
    await writeFile(info.outputPath('recovery-l3-facts.json'), JSON.stringify({ workspace_id: ws.id,
      node_id: l3.id, repaired_parent_id: l2.id, issue_id: issue.id, primary_node_id: issue.primary_node_id,
      read_navigation_mutations: 0, agent_queue_count: 0, mutation_requests: mutationRequests }, null, 2));
  } catch (error) {
    await page.screenshot({ path: info.outputPath('failure-before-cleanup.png'), animations: 'disabled' }).catch(() => {});
    await writeFile(info.outputPath('failure-before-cleanup.txt'), await page.locator('body').innerText()).catch(() => {});
    throw error;
  } finally { if (owns) await api.cleanupCreatedWorkspace(); }
});

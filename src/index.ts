import * as core from '@actions/core';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

interface Job {
    id: number;
    name: string;
    conclusion: string | null;
}

const toList = (value: string): string[] =>
    value.split(',').map(s => s.trim()).filter(s => s.length > 0);

const sleep = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

// the REST API answers 5xx now and then, and always for 100 jobs with their steps in one page,
// so pages are kept small and a retry with backoff rides out the rest
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const status = (error as { status?: number }).status ?? 0;
            if (attempt >= 4 || (status > 0 && status < 500)) {
                throw new Error(`${what} failed after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`);
            }
            await sleep(2 ** attempt);
        }
    }
}

const getNumber = (name: string, fallback?: number): number => {
    const raw = core.getInput(name);
    if (!raw) {
        if (fallback === undefined) {
            throw new Error(`Input '${name}' is required`);
        }
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Input '${name}' must be a non-negative integer, got '${raw}'`);
    }
    return value;
};

async function getFailedJobs(octokit: Octokit, runId: number, attempt: number, ignore: string[]): Promise<Job[]> {
    const { owner, repo } = github.context.repo;
    const jobs = await withRetry('listing jobs', () =>
        octokit.paginate(octokit.rest.actions.listJobsForWorkflowRunAttempt, {
            owner,
            repo,
            run_id: runId,
            attempt_number: attempt,
            per_page: 30,
        })) as Job[];
    return jobs.filter(job => job.conclusion === 'failure' && !ignore.includes(job.name));
}

async function getAnnotationTitles(octokit: Octokit, jobId: number): Promise<string[]> {
    const { owner, repo } = github.context.repo;
    // a job's id is also its check run id
    const annotations = await withRetry(`listing annotations for job ${jobId}`, () =>
        octokit.paginate(octokit.rest.checks.listAnnotations, {
            owner,
            repo,
            check_run_id: jobId,
            per_page: 100,
        }));
    return annotations.map(a => a.title ?? '');
}

const main = async () => {
    try {
        const payload = github.context.payload;
        const runId = getNumber('run-id', payload.workflow_run?.id);
        const attempt = getNumber('run-attempt', payload.workflow_run?.run_attempt);
        const maxAttempts = getNumber('max-attempts', 3);
        const delaySeconds = getNumber('delay-seconds', 0);
        const markers = toList(core.getInput('markers', { required: true }));
        if (markers.length === 0) {
            throw new Error(`Input 'markers' must name at least one annotation title`);
        }
        const ignore = toList(core.getInput('ignore-jobs'));
        const octokit = github.getOctokit(core.getInput('github-token', { required: true }));
        const { owner, repo } = github.context.repo;
        core.setOutput('rerun', false);

        const failed = await getFailedJobs(octokit, runId, attempt, ignore);
        if (failed.length === 0) {
            await core.summary.addRaw(`No failed jobs in run ${runId} attempt ${attempt}.`, true).write();
            return;
        }

        const marked: { name: string; marker: string }[] = [];
        const unmarked: string[] = [];
        for (const job of failed) {
            const titles = await getAnnotationTitles(octokit, job.id);
            const hit = titles.find(title => markers.includes(title));
            // a job with no failed steps may still have failed to start, so only a marker makes it retryable
            if (hit) {
                marked.push({ name: job.name, marker: hit });
            } else {
                unmarked.push(job.name);
            }
        }

        const items = [
            ...marked.map(m => `<code>${m.marker}</code>: ${m.name}`),
            ...unmarked.map(u => `not retryable: ${u}`),
        ];
        core.summary.addHeading(`Retryable failures in run ${runId} attempt ${attempt}`, 3);
        if (items.length > 0) {
            core.summary.addList(items);
        }

        if (marked.length === 0) {
            await core.summary.addRaw('Nothing to rerun: no failure carries a retry marker.', true).write();
            return;
        }
        if (unmarked.length > 0) {
            // a rerun repeats every failed job, so a real failure would only fail again at full cost
            await core.summary.addRaw('Not rerun: other jobs failed for reasons a rerun does not fix.', true).write();
            return;
        }
        if (attempt >= maxAttempts) {
            await core.summary.addRaw(`Not rerun: attempt ${attempt} reached the limit of ${maxAttempts}.`, true).write();
            core.warning(`Run ${runId} still has retryable failures after ${attempt} attempts`);
            return;
        }

        if (delaySeconds > 0) {
            await sleep(delaySeconds);
        }
        // the rerun applies to the run's latest attempt, so skip it if another attempt started since the check
        const current = await withRetry('rerunning failed jobs', async () => {
            const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
            if (run.status !== 'completed' || run.run_attempt !== attempt) {
                return run;
            }
            await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
            return undefined;
        });
        if (current) {
            await core.summary.addRaw(`Not rerun: run ${runId} moved on to attempt ${current.run_attempt} (${current.status}) since attempt ${attempt} was checked.`, true).write();
            return;
        }
        core.setOutput('rerun', true);
        await core.summary.addRaw(`Reran the ${marked.length} failed jobs as attempt ${attempt + 1}.`, true).write();
    } catch (error) {
        core.setFailed(error instanceof Error ? error : String(error));
    }
}

main();

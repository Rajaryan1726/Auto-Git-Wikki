/**
 * Asks one question about an indexed repo through the same RAG path as the chat API
 * (rewrite → searchRepo → re-score → context → stream with fallback).
 *
 *   npm run dev:ask -- <repoId|owner/repo> "<question>" [--follow-up "<earlier question>"]
 *
 * To check the OpenAI fallback, run it with a broken Gemini key, e.g.
 *   GEMINI_API_KEY=invalid npm run dev:ask -- owner/repo "question"
 */
import { eq, or } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { repositories } from '../db/schema.js';
import type { ChatTurn } from '../services/llm.js';
import { prepareAnswer, streamAnswer } from '../services/rag.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fIdx = args.indexOf('--follow-up');
  const earlier = fIdx >= 0 ? args[fIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--follow-up');
  const [repoArg, ...q] = positional;
  const question = q.join(' ').trim();
  if (!repoArg || !question) {
    console.error(
      'Usage: npm run dev:ask -- <repoId|owner/repo> "<question>" [--follow-up "<earlier>"]',
    );
    process.exit(1);
  }
  const isUuid = /^[0-9a-f-]{36}$/i.test(repoArg);
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      isUuid
        ? eq(repositories.id, repoArg)
        : or(eq(repositories.fullName, repoArg), eq(repositories.name, repoArg)),
    )
    .limit(1);
  if (!repo) throw new Error(`Repository not found: ${repoArg}`);

  const history: ChatTurn[] = [];
  if (earlier) {
    const first = await prepareAnswer({
      repoId: repo.id,
      repoFullName: repo.fullName,
      question: earlier,
      history: [],
    });
    let text = '';
    for await (const t of (await streamAnswer(first)).stream) text += t;
    history.push({ role: 'user', content: earlier }, { role: 'assistant', content: text });
  }

  const started = Date.now();
  const prepared = await prepareAnswer({
    repoId: repo.id,
    repoFullName: repo.fullName,
    question,
    history,
  });
  const opened = await streamAnswer(prepared);
  let answer = '';
  for await (const t of opened.stream) answer += t;

  console.log(`# ${repo.fullName} @ ${prepared.commitSha.slice(0, 7)}`);
  console.log(`# question: ${question}`);
  if (prepared.rewritten) console.log(`# search query (rewritten): ${prepared.searchQuery}`);
  console.log(
    `# answered by: ${opened.model}` +
      (opened.failures.length
        ? ` (fallback; failed first: ${opened.failures.map((f) => `${f.model}: ${f.message.slice(0, 80)}`).join('; ')})`
        : ''),
  );
  console.log(`# ${Date.now() - started} ms`);
  console.log('# sources:');
  for (const s of prepared.sources) console.log(`  [${s.n}] ${s.path}:${s.startLine}-${s.endLine}`);
  console.log(`\n${answer}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());

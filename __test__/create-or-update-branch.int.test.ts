import {createOrUpdateBranch, tryFetch} from '../lib/create-or-update-branch'
import * as fs from 'fs'
import {GitCommandManager} from '../lib/git-command-manager'
import * as path from 'path'
import {v4 as uuidv4} from 'uuid'

const REPO_PATH = '/git/test-repo'

const TRACKED_FILE = 'tracked-file.txt'
const UNTRACKED_FILE = 'untracked-file.txt'

const DEFAULT_BRANCH = 'tests/master'
const NOT_BASE_BRANCH = 'tests/branch-that-is-not-the-base'
const NOT_EXIST_BRANCH = 'tests/branch-that-does-not-exist'

const INIT_COMMIT_MESSAGE = 'Add file to be a tracked file for tests'
const BRANCH = 'tests/create-pull-request/patch'
const BASE = DEFAULT_BRANCH

async function createFile(filename: string, content?: string): Promise<string> {
  const _content = content ? content : uuidv4()
  const filepath = path.join(REPO_PATH, filename)
  await fs.promises.writeFile(filepath, _content, {encoding: 'utf8'})
  return _content
}

async function getFileContent(filename: string): Promise<string> {
  const filepath = path.join(REPO_PATH, filename)
  return await fs.promises.readFile(filepath, {encoding: 'utf8'})
}

interface ChangeContent {
  tracked: string
  untracked: string
}

async function createChanges(
  trackedContent?: string,
  untrackedContent?: string
): Promise<ChangeContent> {
  return {
    tracked: await createFile(TRACKED_FILE, trackedContent),
    untracked: await createFile(UNTRACKED_FILE, untrackedContent)
  }
}

interface Commits {
  changes: ChangeContent
  commitMsgs: string[]
}

async function createCommits(
  git: GitCommandManager,
  number = 2,
  finalTrackedContent?: string,
  finalUntrackedContent?: string
): Promise<Commits> {
  let result: Commits = {
    changes: {tracked: '', untracked: ''},
    commitMsgs: []
  }
  for (let i = 1; i <= number; i++) {
    if (i == number) {
      result.changes = await createChanges(
        finalTrackedContent,
        finalUntrackedContent
      )
    } else {
      result.changes = await createChanges()
    }
    const commitMessage = uuidv4()
    await git.exec(['add', '-A'])
    await git.commit(['-m', commitMessage])
    result.commitMsgs.unshift(commitMessage)
  }
  return result
}

describe('create-or-update-branch tests', () => {
  let git: GitCommandManager
  let initCommitHash: string

  beforeAll(async () => {
    git = await GitCommandManager.create(REPO_PATH)
    git.setAuthGitOptions([
      '-c',
      'http.https://github.com/.extraheader=AUTHORIZATION: basic xxx'
    ])
    git.setIdentityGitOptions([
      '-c',
      'author.name=Author Name',
      '-c',
      'author.email=author@example.com',
      '-c',
      'committer.name=Committer Name',
      '-c',
      'committer.email=committer@example.com'
    ])
    // Check there are no local changes that might be destroyed by running these tests
    expect(await git.isDirty(true)).toBeFalsy()
    // Fetch the default branch
    await git.fetch(['master:refs/remotes/origin/master'])

    // Create a "not base branch" for the test run
    await git.checkout('master')
    await git.checkout(NOT_BASE_BRANCH, 'HEAD')
    await createFile(TRACKED_FILE)
    await git.exec(['add', '-A'])
    await git.commit(['-m', 'This commit should not appear in pr branches'])
    await git.push(['--force', 'origin', `HEAD:refs/heads/${NOT_BASE_BRANCH}`])

    // Create a new default branch for the test run with a tracked file
    await git.checkout('master')
    await git.checkout(DEFAULT_BRANCH, 'HEAD')
    await createFile(TRACKED_FILE)
    await git.exec(['add', '-A'])
    await git.commit(['-m', INIT_COMMIT_MESSAGE])
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])
    initCommitHash = await git.revParse('HEAD')
  })

  async function beforeTest(): Promise<void> {
    await git.checkout(DEFAULT_BRANCH)
  }

  async function afterTest(deleteRemote = true): Promise<void> {
    //await git.exec(['log', '-5', '--format=%H %s'])
    await git.checkout(DEFAULT_BRANCH)
    // Delete PR branch
    try {
      await git.exec(['branch', '--delete', '--force', BRANCH])
      if (deleteRemote) {
        await git.push([
          '--delete',
          '--force',
          'origin',
          `refs/heads/${BRANCH}`
        ])
      }
    } catch {
      /* empty */
    }
  }

  beforeEach(async () => {
    await beforeTest()
  })

  afterEach(async () => {
    await afterTest()
    // Reset default branch if it was committed to during the test
    if ((await git.revParse('HEAD')) != initCommitHash) {
      await git.exec(['reset', '--hard', initCommitHash])
      await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])
    }
  })

  async function gitLogMatches(expectedCommitMsgs: string[]): Promise<boolean> {
    const count = expectedCommitMsgs.length
    const result = await git.exec(['log', `-${count}`, '--format=%s'])
    const commitMsgs = result.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(x => x !== '')
    for (var index in expectedCommitMsgs) {
      if (expectedCommitMsgs[index] != commitMsgs[index]) {
        return false
      }
    }
    return true
  }

  it('tests if a branch exists and can be fetched', async () => {
    expect(await tryFetch(git, NOT_BASE_BRANCH)).toBeTruthy()
    expect(await tryFetch(git, NOT_EXIST_BRANCH)).toBeFalsy()
  })

  it('tests no changes resulting in no new branch being created', async () => {
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('none')
    expect(await gitLogMatches([INIT_COMMIT_MESSAGE])).toBeTruthy()
  })

  it('tests create and update with a tracked file change', async () => {
    // Create a tracked file change
    const trackedContent = await createFile(TRACKED_FILE)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(trackedContent)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create a tracked file change
    const _trackedContent = await createFile(TRACKED_FILE)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_trackedContent)
    expect(
      await gitLogMatches([_commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with an untracked file change', async () => {
    // Create an untracked file change
    const untrackedContent = await createFile(UNTRACKED_FILE)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(untrackedContent)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create an untracked file change
    const _untrackedContent = await createFile(UNTRACKED_FILE)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_untrackedContent)
    expect(
      await gitLogMatches([_commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with identical changes', async () => {
    // The pull request branch will not be updated

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create identical tracked and untracked file changes
    await createChanges(changes.tracked, changes.untracked)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('none')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with commits on the base inbetween', async () => {
    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commits = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })

  it('tests create and then an update with no changes', async () => {
    // This effectively reverts the branch back to match the base and results in no diff

    // Save the default branch tracked content
    const defaultTrackedContent = await getFileContent(TRACKED_FILE)

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Running with no update effectively reverts the branch back to match the base
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeFalsy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(defaultTrackedContent)
    expect(await gitLogMatches([INIT_COMMIT_MESSAGE])).toBeTruthy()
  })

  it('tests create, commits on the base, and update with identical changes to the base', async () => {
    // The changes on base effectively revert the branch back to match the base and results in no diff

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commits = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Create the same tracked and untracked file changes that were made to the base
    const _changes = await createChanges(
      commits.changes.tracked,
      commits.changes.untracked
    )
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeFalsy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([...commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with commits on the working base (during the workflow)', async () => {
    // Create commits on the working base
    const commits = await createCommits(git)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(commits.changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(
      commits.changes.untracked
    )
    expect(
      await gitLogMatches([...commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the working base
    const _commits = await createCommits(git)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_commits.changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(
      _commits.changes.untracked
    )
    expect(
      await gitLogMatches([..._commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with changes and commits on the working base (during the workflow)', async () => {
    // Create commits on the working base
    const commits = await createCommits(git)
    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([
        commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the working base
    const _commits = await createCommits(git)
    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ..._commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })

  it('tests create and update with changes and commits on the working base (during the workflow), and commits on the base inbetween', async () => {
    // Create commits on the working base
    const commits = await createCommits(git)
    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, '', BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([
        commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commitsOnBase = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Create commits on the working base
    const _commits = await createCommits(git)
    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(git, _commitMessage, '', BRANCH)
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ..._commits.commitMsgs,
        ...commitsOnBase.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })

  // Working Base is Not Base (WBNB)

  it('tests no changes resulting in no new branch being created (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('none')
    expect(await gitLogMatches([INIT_COMMIT_MESSAGE])).toBeTruthy()
  })

  it('tests create and update with a tracked file change (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create a tracked file change
    const trackedContent = await createFile(TRACKED_FILE)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(trackedContent)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create a tracked file change
    const _trackedContent = await createFile(TRACKED_FILE)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_trackedContent)
    expect(
      await gitLogMatches([_commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with an untracked file change (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create an untracked file change
    const untrackedContent = await createFile(UNTRACKED_FILE)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(untrackedContent)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create an untracked file change
    const _untrackedContent = await createFile(UNTRACKED_FILE)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_untrackedContent)
    expect(
      await gitLogMatches([_commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with identical changes (WBNB)', async () => {
    // The pull request branch will not be updated

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create identical tracked and untracked file changes
    await createChanges(changes.tracked, changes.untracked)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('none')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with commits on the base inbetween (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commits = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })

  it('tests create and then an update with no changes (WBNB)', async () => {
    // This effectively reverts the branch back to match the base and results in no diff

    // Save the default branch tracked content
    const defaultTrackedContent = await getFileContent(TRACKED_FILE)

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Running with no update effectively reverts the branch back to match the base
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeFalsy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(defaultTrackedContent)
    expect(await gitLogMatches([INIT_COMMIT_MESSAGE])).toBeTruthy()
  })

  it('tests create, commits on the base, and update with identical changes to the base (WBNB)', async () => {
    // The changes on base effectively revert the branch back to match the base and results in no diff
    // This scenario will cause cherrypick to fail due to an empty commit.
    // The commit is empty because the changes now exist on the base.

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([commitMessage, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commits = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create the same tracked and untracked file changes that were made to the base
    const _changes = await createChanges(
      commits.changes.tracked,
      commits.changes.untracked
    )
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeFalsy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([...commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with commits on the working base (during the workflow) (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const commits = await createCommits(git)
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(commits.changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(
      commits.changes.untracked
    )
    expect(
      await gitLogMatches([...commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const _commits = await createCommits(git)
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_commits.changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(
      _commits.changes.untracked
    )
    expect(
      await gitLogMatches([..._commits.commitMsgs, INIT_COMMIT_MESSAGE])
    ).toBeTruthy()
  })

  it('tests create and update with changes and commits on the working base (during the workflow) (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const commits = await createCommits(git)
    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([
        commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const _commits = await createCommits(git)
    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ..._commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })

  it('tests create and update with changes and commits on the working base (during the workflow), and commits on the base inbetween (WBNB)', async () => {
    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const commits = await createCommits(git)
    // Create tracked and untracked file changes
    const changes = await createChanges()
    const commitMessage = uuidv4()
    const result = await createOrUpdateBranch(git, commitMessage, BASE, BRANCH)
    expect(result.action).toEqual('created')
    expect(await getFileContent(TRACKED_FILE)).toEqual(changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(changes.untracked)
    expect(
      await gitLogMatches([
        commitMessage,
        ...commits.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()

    // Push pull request branch to remote
    await git.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`])

    await afterTest(false)
    await beforeTest()

    // Create commits on the base
    const commitsOnBase = await createCommits(git)
    await git.push(['--force', 'origin', `HEAD:refs/heads/${DEFAULT_BRANCH}`])

    // Set the working base to a branch that is not the pull request base
    await git.checkout(NOT_BASE_BRANCH)

    // Create commits on the working base
    const _commits = await createCommits(git)
    // Create tracked and untracked file changes
    const _changes = await createChanges()
    const _commitMessage = uuidv4()
    const _result = await createOrUpdateBranch(
      git,
      _commitMessage,
      BASE,
      BRANCH
    )
    expect(_result.action).toEqual('updated')
    expect(_result.hasDiffWithBase).toBeTruthy()
    expect(await getFileContent(TRACKED_FILE)).toEqual(_changes.tracked)
    expect(await getFileContent(UNTRACKED_FILE)).toEqual(_changes.untracked)
    expect(
      await gitLogMatches([
        _commitMessage,
        ..._commits.commitMsgs,
        ...commitsOnBase.commitMsgs,
        INIT_COMMIT_MESSAGE
      ])
    ).toBeTruthy()
  })
})
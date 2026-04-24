// then-later/storage/JobRepository.gs - Job CRUD operations with batch processing

function _main(module, exports, log) {

  const { JOB_STATES, FileUtils } = require('then-later/storage/JobStateManager');

  class NoResultsFoundError extends Error {
    constructor(functionName, tag) {
      super(`No results found for ${functionName}${tag ? ` with tag "${tag}"` : ''}`);
      this.name = 'NoResultsFoundError';
      this.functionName = functionName;
      this.tag = tag;
    }
  }

  class JobValidationError extends Error {
    constructor(message) {
      super(`Job validation error: ${message}`);
      this.name = 'JobValidationError';
    }
  }

  class JobRepository {
    constructor(config = {}) {
      if (!config.driveStorage) {
        throw new Error('JobRepository requires driveStorage instance');
      }

      this.driveStorage = config.driveStorage;
    }

    createJob(jobData, folderType = 'jobs', state = JOB_STATES.PENDING) {
      log('Creating job | ' + JSON.stringify({ state, folderType }));

      if (!jobData.jobId) {
        jobData.jobId = FileUtils.generateJobId();
      }

      jobData.state = state;

      if (!jobData.metadata) {
        jobData.metadata = {};
      }

      if (!jobData.metadata.created) {
        jobData.metadata.created = new Date().toISOString();
      }

      const filename = FileUtils.createJobFilename(
        state,
        jobData.jobId,
        jobData.metadata.description || ''
      );

      try {
        const folder = this.driveStorage.getFolder(folderType);
        const file = folder.createFile(filename, JSON.stringify(jobData));

        log('Job created | ' + JSON.stringify({ jobId: jobData.jobId, filename, state }));

        return file;
      } catch (error) {
        log('[E] Failed to create job: ' + error.message + ' | ' + JSON.stringify({ jobId: jobData.jobId, state }));
        throw new Error(`Failed to create job file: ${error.message}`);
      }
    }

    validateJobStructure(job) {
      if (job == null) {
        throw new JobValidationError('Job object cannot be null or undefined');
      }

      if (!job.steps || !Array.isArray(job.steps)) {
        throw new JobValidationError('Invalid job structure: missing steps array');
      }

      job.steps.forEach((step, index) => {
        if (!step.functionPath || typeof step.functionPath !== 'string') {
          throw new JobValidationError(`Step ${index}: missing functionPath`);
        }
        if (!step.parameters || !Array.isArray(step.parameters)) {
          throw new JobValidationError(`Step ${index}: missing parameters array`);
        }
      });
    }

    pickup(functionName, tag, keepFile = false) {
      log('Picking up result | ' + JSON.stringify({ functionName, tag, keepFile }));

      const searchOrder = [
        { folder: 'results', prefix: 'SUCCESS-' },
        { folder: 'deadLetters', prefix: 'FAILED-' }
      ];

      for (const { folder, prefix } of searchOrder) {
        const folderObj = this.driveStorage.getFolder(folder);
        const files = folderObj.getFiles();

        while (files.hasNext()) {
          const file = files.next();

          const content = this.parseFileContent(file);

          if (content && this.matchesCriteria(content, functionName, tag)) {
            const [actualResult, metadata] = this.formatResult(
              content,
              folder === 'results',
              file.getName()
            );

            if (!keepFile) {
              try {
                file.setTrashed(true);
                log('Deleted result file | ' + JSON.stringify({ filename: file.getName() }));
              } catch (e) {
                log('[W] Failed to delete result file | ' + JSON.stringify({ filename: file.getName(), error: e.message }));
              }
            }

            log('Result picked up | ' + JSON.stringify({ functionName, tag }));
            return [actualResult, metadata];
          }
        }
      }

      throw new NoResultsFoundError(functionName, tag);
    }

    peek(functionName, tag) {
      log('Peeking at result | ' + JSON.stringify({ functionName, tag }));

      try {
        return this.pickup(functionName, tag, true);
      } catch (e) {
        if (e instanceof NoResultsFoundError) {
          return [null, null];
        }
        throw e;
      }
    }

    getJobBatch(limit = 5) {
      log('Retrieving job batch | ' + JSON.stringify({ limit }));

      const jobsFolder = this.driveStorage.getFolder('jobs');
      const files = jobsFolder.getFiles();
      const batch = [];

      while (files.hasNext() && batch.length < limit) {
        batch.push(files.next());
      }

      log('Job batch retrieved | ' + JSON.stringify({ count: batch.length }));
      return batch;
    }

    findEarliestFutureJobTime() {
      log('Finding earliest future job time');

      let earliest = null;
      const jobsFolder = this.driveStorage.getFolder('jobs');
      const files = jobsFolder.getFiles();

      while (files.hasNext()) {
        const file = files.next();
        try {
          const content = JSON.parse(file.getBlob().getDataAsString());
          if (content && content.metadata && content.metadata.startEarliestTime) {
            const ms = Date.parse(content.metadata.startEarliestTime);
            if (!isNaN(ms)) {
              if (earliest === null || ms < earliest) {
                earliest = ms;
              }
            }
          }
        } catch (e) {
          // Parse error, ignore
        }
      }

      const result = earliest ? new Date(earliest) : null;
      if (result) {
        log('Found earliest future job | ' + JSON.stringify({ time: result.toISOString() }));
      }

      return result;
    }

    parseFileContent(file) {
      try {
        return JSON.parse(file.getBlob().getDataAsString());
      } catch (e) {
        log('[W] Failed to parse file | ' + JSON.stringify({ filename: file.getName(), error: e.message }));
        return null;
      }
    }

    matchesCriteria(content, functionName, tag) {
      if (!content || !content.metadata || !content.metadata.originalJob) return false;

      const jobMeta = content.metadata.originalJob;

      if (!jobMeta.steps || !Array.isArray(jobMeta.steps)) return false;

      return (
        jobMeta.steps.some(step => step.functionPath === functionName) &&
        (!tag || (jobMeta.metadata && jobMeta.metadata.tags && jobMeta.metadata.tags.includes(tag)))
      );
    }

    formatResult(content, isSuccess, fileName) {
      const metadata = {
        ...content.metadata,
        fileName: fileName,
        jobId: (content.metadata.originalJob && content.metadata.originalJob.jobId) || 'N/A',
        success: isSuccess
      };

      const actualResult = isSuccess ? content.results : content.error;
      return [actualResult, metadata];
    }

    listJobs(folderType, limit = 100) {
      log('Listing jobs | ' + JSON.stringify({ folderType, limit }));

      const folder = this.driveStorage.getFolder(folderType);
      const files = folder.getFiles();
      const jobs = [];

      while (files.hasNext() && jobs.length < limit) {
        const file = files.next();
        const content = this.parseFileContent(file);

        if (content) {
          jobs.push({
            filename: file.getName(),
            jobId: content.jobId,
            state: content.state,
            created: content.metadata && content.metadata.created,
            ...content
          });
        }
      }

      log('Jobs listed | ' + JSON.stringify({ count: jobs.length }));
      return jobs;
    }
  }

  module.exports = {
    JobRepository,
    NoResultsFoundError,
    JobValidationError
  };
}

__defineModule__(_main);

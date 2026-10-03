import { ConfigurationError } from './configuration.mjs';

/** Preserves admitted workers and replaces only stopped containers from an older release. */
export class WorkerRelease {
  #obsolete = [];

  constructor({ docker, identifiers, imageId, count }) {
    this.docker = docker;
    this.identifiers = identifiers;
    this.imageId = imageId;
    this.count = count;
  }

  async prepare() {
    const ids = await this.identifiers();
    if (ids.length > this.count) {
      throw new ConfigurationError('WORKER_COUNT', 'close admission and drain the existing pool before reducing its size');
    }
    const obsolete = [];
    for (const id of ids) {
      const current = JSON.parse((await this.docker(['inspect', id])).stdout)[0];
      if (current.Image === this.imageId) continue;
      if (current.State.Running) {
        throw new ConfigurationError('browser-worker release', 'drain active browser work before replacing this running component');
      }
      obsolete.push(id);
    }
    this.#obsolete = obsolete;
  }

  async removeObsolete() {
    // No force or volume deletion: the daemon refuses removal if a worker started after preflight.
    for (const id of this.#obsolete) await this.docker(['rm', id]);
    this.#obsolete = [];
  }

  async verify() {
    const ids = await this.identifiers();
    if (ids.length !== this.count) throw new Error('Browser worker count does not match the selected deployment');
    for (const id of ids) {
      const current = JSON.parse((await this.docker(['inspect', id])).stdout)[0];
      if (current.Image !== this.imageId) throw new Error('Browser worker image does not match the selected release');
    }
  }
}

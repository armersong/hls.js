import { Events } from '../events';
import { logger } from '../utils/logger';
import { ErrorDetails, ErrorTypes } from '../errors';
import { BufferHelper } from '../utils/buffer-helper';
import { getMediaSource } from '../utils/mediasource-helper';
import { ElementaryStreamTypes } from '../loader/fragment';
import { TrackSet } from '../types/track';
import BufferOperationQueue from './buffer-operation-queue';
import {
  BufferOperation,
  SourceBuffers,
  SourceBufferName,
  SourceBufferListeners
} from '../types/buffer';
import { LevelUpdatedData, BufferAppendingData, MediaAttachingData, ManifestParsedData, BufferCodecsData, LevelPTSUpdatedData, BufferEOSData, BufferFlushingData, FragParsedData } from '../types/events';
import { ComponentAPI } from '../types/component-api';
import Hls from '../hls';

const MediaSource = getMediaSource();

export default class BufferController implements ComponentAPI {
  // the value that we have set mediasource.duration to
  // (the actual duration may be tweaked slighly by the browser)
  private _msDuration: number | null = null;
  // the target duration of the current media playlist
  private _levelTargetDuration: number | null = null;
  // current stream state: true - for live broadcast, false - for VoD content
  private _live: boolean = false;
  // cache the self generated object url to detect hijack of video tag
  private _objectUrl: string | null = null;
  // A queue of buffer operations which require the SourceBuffer to not be updating upon execution
  private operationQueue!: BufferOperationQueue;
  // References to event listeners for each SourceBuffer, so that they can be referenced for event removal
  private listeners!: SourceBufferListeners;

  private hls: Hls;

  // The number of BUFFER_CODEC events received before any sourceBuffers are created
  public bufferCodecEventsExpected: number = 0;

  // The total number of BUFFER_CODEC events received
  private _bufferCodecEventsTotal: number = 0;

  // A reference to the attached media element
  public media: HTMLMediaElement | null = null;

  // A reference to the active media source
  public mediaSource: MediaSource | null = null;

  // counters
  public appendError: number = 0;

  public tracks: TrackSet = {};
  public pendingTracks: TrackSet = {};
  public sourceBuffer!: SourceBuffers;

  constructor (hls: Hls) {
    this.hls = hls;
    this._initSourceBuffer();
    this.registerListeners();
  }

  public destroy () {
    this.unregisterListeners();
  }

  protected registerListeners () {
    const { hls } = this;
    hls.on(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.on(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
    hls.on(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    hls.on(Events.BUFFER_RESET, this.onBufferReset, this);
    hls.on(Events.BUFFER_APPENDING, this.onBufferAppending, this);
    hls.on(Events.BUFFER_CODECS, this.onBufferCodecs, this);
    hls.on(Events.BUFFER_EOS, this.onBufferEos, this);
    hls.on(Events.BUFFER_FLUSHING, this.onBufferFlushing, this);
    hls.on(Events.LEVEL_PTS_UPDATED, this.onLevelPtsUpdated, this);
    hls.on(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
    hls.on(Events.FRAG_PARSED, this.onFragParsed, this);
  }

  protected unregisterListeners () {
    const { hls } = this;
    hls.off(Events.MEDIA_ATTACHING, this.onMediaAttaching, this);
    hls.off(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
    hls.off(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    hls.off(Events.BUFFER_RESET, this.onBufferReset, this);
    hls.off(Events.BUFFER_APPENDING, this.onBufferAppending, this);
    hls.off(Events.BUFFER_CODECS, this.onBufferCodecs, this);
    hls.off(Events.BUFFER_EOS, this.onBufferEos, this);
    hls.off(Events.BUFFER_FLUSHING, this.onBufferFlushing, this);
    hls.off(Events.LEVEL_PTS_UPDATED, this.onLevelPtsUpdated, this);
    hls.off(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
    hls.off(Events.FRAG_PARSED, this.onFragParsed, this);
  }

  private _initSourceBuffer () {
    this.sourceBuffer = {};
    this.operationQueue = new BufferOperationQueue(this.sourceBuffer);
    this.listeners = {
      audio: [],
      video: [],
      audiovideo: []
    };
  }

  protected onManifestParsed (event: Events.MANIFEST_PARSED, data: ManifestParsedData) {
    // in case of alt audio 2 BUFFER_CODECS events will be triggered, one per stream controller
    // sourcebuffers will be created all at once when the expected nb of tracks will be reached
    // in case alt audio is not used, only one BUFFER_CODEC event will be fired from main stream controller
    // it will contain the expected nb of source buffers, no need to compute it
    let codecEvents: number = 2;
    if (data.audio && !data.video || !data.altAudio) {
      codecEvents = 1;
    }
    this.bufferCodecEventsExpected = this._bufferCodecEventsTotal = codecEvents;

    logger.log(`${this.bufferCodecEventsExpected} bufferCodec event(s) expected`);
  }

  protected onMediaAttaching (event: Events.MEDIA_ATTACHING, data: MediaAttachingData) {
    const media = this.media = data.media;
    if (media && MediaSource) {
      const ms = this.mediaSource = new MediaSource();
      // MediaSource listeners are arrow functions with a lexical scope, and do not need to be bound
      ms.addEventListener('sourceopen', this._onMediaSourceOpen);
      ms.addEventListener('sourceended', this._onMediaSourceEnded);
      ms.addEventListener('sourceclose', this._onMediaSourceClose);
      // link video and media Source
      media.src = self.URL.createObjectURL(ms);
      // cache the locally generated object url
      this._objectUrl = media.src;
    }
  }

  protected onMediaDetaching () {
    logger.log('media source detaching');
    const { media, mediaSource, _objectUrl } = this;
    if (mediaSource) {
      if (mediaSource.readyState === 'open') {
        try {
          // endOfStream could trigger exception if any sourcebuffer is in updating state
          // we don't really care about checking sourcebuffer state here,
          // as we are anyway detaching the MediaSource
          // let's just avoid this exception to propagate
          mediaSource.endOfStream();
        } catch (err) {
          logger.warn(`onMediaDetaching:${err.message} while calling endOfStream`);
        }
      }
      // Clean up the SourceBuffers by invoking onBufferReset
      this.onBufferReset();
      mediaSource.removeEventListener('sourceopen', this._onMediaSourceOpen);
      mediaSource.removeEventListener('sourceended', this._onMediaSourceEnded);
      mediaSource.removeEventListener('sourceclose', this._onMediaSourceClose);

      // Detach properly the MediaSource from the HTMLMediaElement as
      // suggested in https://github.com/w3c/media-source/issues/53.
      if (media) {
        if (_objectUrl) {
          self.URL.revokeObjectURL(_objectUrl);
        }

        // clean up video tag src only if it's our own url. some external libraries might
        // hijack the video tag and change its 'src' without destroying the Hls instance first
        if (media.src === _objectUrl) {
          media.removeAttribute('src');
          media.load();
        } else {
          logger.warn('media.src was changed by a third party - skip cleanup');
        }
      }

      this.mediaSource = null;
      this.media = null;
      this._objectUrl = null;
      this.bufferCodecEventsExpected = this._bufferCodecEventsTotal;
      this.pendingTracks = {};
      this.tracks = {};
    }

    this.hls.trigger(Events.MEDIA_DETACHED, undefined);
  }

  protected onBufferReset () {
    const sourceBuffer = this.sourceBuffer;
    this.getSourceBufferTypes().forEach(type => {
      const sb = sourceBuffer[type];
      try {
        if (sb) {
          this.removeBufferListeners(type);
          if (this.mediaSource) {
            this.mediaSource.removeSourceBuffer(sb);
          }
          // Synchronously remove the SB from the map before the next call in order to prevent an async function from
          // accessing it
          sourceBuffer[type] = undefined;
        }
      } catch (err) {
        logger.warn(`Failed to reset the ${type} buffer`, err);
      }
    });
    this._initSourceBuffer();
  }

  protected onBufferCodecs (event: Events.BUFFER_CODECS, data: BufferCodecsData) {
    // if source buffer(s) not created yet, appended buffer tracks in this.pendingTracks
    // if sourcebuffers already created, do nothing ...
    if (Object.keys(this.sourceBuffer).length) {
      return;
    }

    Object.keys(data).forEach(trackName => {
      this.pendingTracks[trackName] = data[trackName];
    });

    this.bufferCodecEventsExpected = Math.max(this.bufferCodecEventsExpected - 1, 0);
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      this.checkPendingTracks();
    }
  }

  protected onBufferAppending (event: Events.BUFFER_APPENDING, eventData: BufferAppendingData) {
    const { hls, operationQueue } = this;
    const { data, type, frag, chunkMeta } = eventData;
    const chunkStats = chunkMeta.buffering[type];
    const fragStats = frag.stats.buffering;

    const start = performance.now();
    chunkStats.start = start;
    if (!fragStats.start) {
      fragStats.start = start;
    }

    const operation: BufferOperation = {
      execute: () => {
        chunkStats.executeStart = performance.now();
        this.appendExecutor(data, type);
      },
      onStart: () => {
        logger.debug(`[buffer-controller]: ${type} SourceBuffer updatestart`);
      },
      onComplete: () => {
        logger.debug(`[buffer-controller]: ${type} SourceBuffer updateend`);
        const end = performance.now();
        chunkStats.executeEnd = chunkStats.end = end;
        if (!fragStats.first) {
          fragStats.first = end;
        }

        const { sourceBuffer } = this;
        const timeRanges = {};
        for (const type in sourceBuffer) {
          timeRanges[type] = BufferHelper.getBuffered(sourceBuffer[type]);
        }
        this.appendError = 0;
        this.hls.trigger(Events.BUFFER_APPENDED, { parent: frag.type, timeRanges, frag, chunkMeta });
      },
      onError: (err) => {
        // in case any error occured while appending, put back segment in segments table
        logger.error(`[buffer-controller]: Error encountered while trying to append to the ${type} SourceBuffer`, err);
        const event = {
          type: ErrorTypes.MEDIA_ERROR,
          parent: frag.type,
          details: ErrorDetails.BUFFER_APPEND_ERROR,
          err,
          fatal: false
        };

        if (err.code === DOMException.QUOTA_EXCEEDED_ERR) {
          // QuotaExceededError: http://www.w3.org/TR/html5/infrastructure.html#quotaexceedederror
          // let's stop appending any segments, and report BUFFER_FULL_ERROR error
          event.details = ErrorDetails.BUFFER_FULL_ERROR;
        } else {
          this.appendError++;
          event.details = ErrorDetails.BUFFER_APPEND_ERROR;
          /* with UHD content, we could get loop of quota exceeded error until
            browser is able to evict some data from sourcebuffer. Retrying can help recover.
          */
          if (this.appendError > hls.config.appendErrorMaxRetry) {
            logger.log(`[buffer-controller]: Failed ${hls.config.appendErrorMaxRetry} times to append segment in sourceBuffer`);
            event.fatal = true;
          }
        }
        hls.trigger(Events.ERROR, event);
      }
    };
    operationQueue.append(operation, type);
  }

  protected onBufferFlushing (event: Events.BUFFER_FLUSHING, data: BufferFlushingData) {
    const { operationQueue } = this;
    const flushOperation = (type): BufferOperation => ({
      execute: this.removeExecutor.bind(this, type, data.startOffset, data.endOffset),
      onStart: () => {
        logger.debug(`[buffer-controller]: Started flushing ${data.startOffset} -> ${data.endOffset} for ${type} Source Buffer`);
      },
      onComplete: () => {
        logger.debug(`[buffer-controller]: Finished flushing ${data.startOffset} -> ${data.endOffset} for ${type} Source Buffer`);
        this.hls.trigger(Events.BUFFER_FLUSHED, { type });
      },
      onError: (e) => {
        logger.warn(`[buffer-controller]: Failed to remove from ${type} SourceBuffer`, e);
      }
    });

    if (data.type) {
      operationQueue.append(flushOperation(data.type), data.type);
    } else {
      operationQueue.append(flushOperation('audio'), 'audio');
      operationQueue.append(flushOperation('video'), 'video');
    }
  }

  protected onFragParsed (event: Events.FRAG_PARSED, data: FragParsedData) {
    const { frag } = data;
    const buffersAppendedTo: Array<SourceBufferName> = [];

    if (frag.elementaryStreams[ElementaryStreamTypes.AUDIOVIDEO]) {
      buffersAppendedTo.push('audiovideo');
    } else {
      if (frag.elementaryStreams[ElementaryStreamTypes.AUDIO]) {
        buffersAppendedTo.push('audio');
      }
      if (frag.elementaryStreams[ElementaryStreamTypes.VIDEO]) {
        buffersAppendedTo.push('video');
      }
    }

    const onUnblocked = () => {
      frag.stats.buffering.end = self.performance.now();
      this.hls.trigger(Events.FRAG_BUFFERED, { frag, stats: frag.stats, id: frag.type });
    };

    // console.assert(buffersAppendedTo.length, 'Fragments must have at least one ElementaryStreamType set', frag);
    if (buffersAppendedTo.length === 0) {
      logger.warn(`Fragments must have at least one ElementaryStreamType set. type: ${frag.type} level: ${frag.level} sn: ${frag.sn}`);
      onUnblocked();
      return;
    }

    this.blockBuffers(onUnblocked, buffersAppendedTo);
    this.flushLiveBackBuffer();
  }

  // on BUFFER_EOS mark matching sourcebuffer(s) as ended and trigger checkEos()
  // an undefined data.type will mark all buffers as EOS.
  protected onBufferEos (event: Events.BUFFER_EOS, data: BufferEOSData) {
    for (const type in this.sourceBuffer) {
      if (!data.type || data.type === type) {
        const sb = this.sourceBuffer[type as SourceBufferName];
        if (sb && !sb.ended) {
          sb.ended = true;
          logger.log(`[buffer-controller]: ${type} sourceBuffer now EOS`);
        }
      }
    }

    const endStream = () => {
      const { mediaSource } = this;
      if (!mediaSource || mediaSource.readyState !== 'open') {
        return;
      }

      logger.log('[buffer-controller]: Signaling end of stream');
      // Allow this to throw and be caught by the enqueueing function
      mediaSource.endOfStream();
    };
    logger.log('[buffer-controller: End of stream signalled, enqueuing end of stream operation');
    this.blockBuffers(endStream);
  }

  protected onLevelUpdated (event: Events.LEVEL_UPDATED, { details }: LevelUpdatedData) {
    if (!details.fragments.length) {
      return;
    }
    this._levelTargetDuration = details.levelTargetDuration;
    this._live = details.live;

    const levelEnd = details.fragments[0].start + details.totalduration;
    logger.log('[buffer-controller]: Duration update required; enqueueing duration change operation');
    if (this.getSourceBufferTypes().length) {
      this.blockBuffers(this.updateMediaElementDuration.bind(this, levelEnd));
    } else {
      this.updateMediaElementDuration(levelEnd);
      if (this.hls.config.liveDurationInfinity) {
        this.updateSeekableRange(details);
      }
    }
  }

  // Adjusting `SourceBuffer.timestampOffset` (desired point in the timeline where the next frames should be appended)
  // in Chrome browser when we detect MPEG audio container and time delta between level PTS and `SourceBuffer.timestampOffset`
  // is greater than 100ms (this is enough to handle seek for VOD or level change for LIVE videos). At the time of change we issue
  // `SourceBuffer.abort()` and adjusting `SourceBuffer.timestampOffset` if `SourceBuffer.updating` is false or awaiting `updateend`
  // event if SB is in updating state.
  // More info here: https://github.com/video-dev/hls.js/issues/332#issuecomment-257986486
  protected onLevelPtsUpdated (event: Events.LEVEL_PTS_UPDATED, data: LevelPTSUpdatedData) {
    const { operationQueue, sourceBuffer, tracks } = this;
    const type = data.type;
    const audioTrack = tracks.audio;

    if (type !== 'audio' || (audioTrack && audioTrack.container !== 'audio/mpeg')) {
      return;
    }
    const audioBuffer = sourceBuffer[type];
    if (!audioBuffer) {
      return;
    }
    const delta = Math.abs(audioBuffer.timestampOffset - data.start);
    if (delta < 0.1) {
      return;
    }

    const operation = {
      execute: this.abortExecutor.bind(this, type),
      onStart () {
        logger.debug(`[buffer-controller]: Starting abort on source buffer ${type}`);
      },
      onComplete () {
        if (audioBuffer) {
          logger.log(`[buffer-controller]: Updating audio SourceBuffer timestampOffset to ${data.start}`);
          audioBuffer.timestampOffset = data.start;
        }
      },
      onError (e) {
        logger.warn('[buffer-controller]: Failed to abort the audio SourceBuffer', e);
      }
    };
    operationQueue.insertAbort(operation, type);

    if (this.hls.config.liveDurationInfinity) {
      this.updateSeekableRange(data.details);
    }
  }

  flushLiveBackBuffer () {
    // clear back buffer for live only
    const { hls, _levelTargetDuration, _live, media, sourceBuffer } = this;
    if (!media || !_live || _levelTargetDuration === null) {
      return;
    }

    const liveBackBufferLength = hls.config.liveBackBufferLength;
    if (!Number.isFinite(liveBackBufferLength) || liveBackBufferLength < 0) {
      return;
    }

    const currentTime = media.currentTime;
    const targetBackBufferPosition = currentTime - Math.max(liveBackBufferLength, _levelTargetDuration);
    this.getSourceBufferTypes().forEach((type: SourceBufferName) => {
      const sb = sourceBuffer[type];
      if (sb) {
        const buffered = BufferHelper.getBuffered(sb);
        // when target buffer start exceeds actual buffer start
        if (buffered.length > 0 && targetBackBufferPosition > buffered.start(0)) {
          hls.trigger(Events.LIVE_BACK_BUFFER_REACHED, { bufferEnd: targetBackBufferPosition });
          hls.trigger(Events.BUFFER_FLUSHING, { startOffset: 0, endOffset: targetBackBufferPosition, type });
        }
      }
    });
  }

  /**
   * Update Media Source duration to current level duration or override to Infinity if configuration parameter
   * 'liveDurationInfinity` is set to `true`
   * More details: https://github.com/video-dev/hls.js/issues/355
   */
  private updateMediaElementDuration (levelDuration: number) {
    if (!this.media || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }
    const { hls, _live, media, mediaSource, _msDuration } = this;
    const mediaDuration = media.duration;

    // initialise to the value that the media source is reporting
    let msDuration = _msDuration;
    if (msDuration === null) {
      this._msDuration = msDuration = mediaSource.duration;
    }

    if (_live && hls.config.liveDurationInfinity) {
      // Override duration to Infinity
      logger.log('[buffer-controller]: Media Source duration is set to Infinity');
      this._msDuration = mediaSource.duration = Infinity;
    } else if ((levelDuration > msDuration && levelDuration > mediaDuration) || !Number.isFinite(mediaDuration)) {
      // levelDuration was the last value we set.
      // not using mediaSource.duration as the browser may tweak this value
      // only update Media Source duration if its value increase, this is to avoid
      // flushing already buffered portion when switching between quality level
      logger.log(`[buffer-controller]: Updating Media Source duration to ${levelDuration.toFixed(3)}`);
      this._msDuration = mediaSource.duration = levelDuration;
    }
  }

  updateSeekableRange (levelDetails) {
    const mediaSource = this.mediaSource;
    const fragments = levelDetails.fragments;
    const len = fragments.length;
    if (len && mediaSource?.setLiveSeekableRange) {
      const start = fragments[0].start;
      const end = start + levelDetails.totalduration;
      mediaSource.setLiveSeekableRange(start, end);
    }
  }

  protected checkPendingTracks () {
    const { bufferCodecEventsExpected, operationQueue, pendingTracks } = this;

    // Check if we've received all of the expected bufferCodec events. When none remain, create all the sourceBuffers at once.
    // This is important because the MSE spec allows implementations to throw QuotaExceededErrors if creating new sourceBuffers after
    // data has been appended to existing ones.
    // 2 tracks is the max (one for audio, one for video). If we've reach this max go ahead and create the buffers.
    const pendingTracksCount = Object.keys(pendingTracks).length;
    if ((pendingTracksCount && !bufferCodecEventsExpected) || pendingTracksCount === 2) {
      // ok, let's create them now !
      this.createSourceBuffers(pendingTracks);
      this.pendingTracks = {};
      // append any pending segments now !
      Object.keys(this.sourceBuffer).forEach((type: SourceBufferName) => {
        operationQueue.executeNext(type);
      });
    }
  }

  protected createSourceBuffers (tracks: TrackSet) {
    const { sourceBuffer, mediaSource } = this;
    if (!mediaSource) {
      throw Error('createSourceBuffers called when mediaSource was null');
    }

    for (const trackName in tracks) {
      if (!sourceBuffer[trackName]) {
        const track = tracks[trackName as keyof TrackSet];
        if (!track) {
          throw Error(`source buffer exists for track ${trackName}, however track does not`);
        }
        // use levelCodec as first priority
        const codec = track.levelCodec || track.codec;
        const mimeType = `${track.container};codecs=${codec}`;
        logger.log(`creating sourceBuffer(${mimeType})`);
        try {
          const sb = sourceBuffer[trackName] = mediaSource.addSourceBuffer(mimeType);
          const sbName = trackName as SourceBufferName;
          this.addBufferListener(sbName, 'updatestart', this._onSBUpdateStart);
          this.addBufferListener(sbName, 'updateend', this._onSBUpdateEnd);
          this.addBufferListener(sbName, 'error', this._onSBUpdateError);
          this.tracks[trackName] = {
            buffer: sb,
            codec: codec,
            container: track.container,
            levelCodec: track.levelCodec,
            id: track.id
          };
        } catch (err) {
          logger.error(`error while trying to add sourceBuffer:${err.message}`);
          this.hls.trigger(Events.ERROR, {
            type: ErrorTypes.MEDIA_ERROR,
            details: ErrorDetails.BUFFER_ADD_CODEC_ERROR,
            fatal: false,
            error: err,
            mimeType: mimeType
          });
        }
      }
    }
    this.hls.trigger(Events.BUFFER_CREATED, { tracks: this.tracks });
  }

  // Keep as arrow functions so that we can directly reference these functions directly as event listeners
  private _onMediaSourceOpen = () => {
    const { hls, media, mediaSource } = this;
    logger.log('media source opened');
    if (media) {
      hls.trigger(Events.MEDIA_ATTACHED, { media });
    } else {
      logger.log('[buffer-controller]: Media source opened, and no media was attached');
    }

    if (mediaSource) {
      // once received, don't listen anymore to sourceopen event
      mediaSource.removeEventListener('sourceopen', this._onMediaSourceOpen);
    }
    this.checkPendingTracks();
  };

  private _onMediaSourceClose = () => {
    logger.log('[buffer-controller]: Media source closed');
  };

  private _onMediaSourceEnded = () => {
    logger.log('[buffer-controller]: Media source ended');
  };

  private _onSBUpdateStart (type: SourceBufferName) {
    const { operationQueue } = this;
    const operation = operationQueue.current(type);
    operation.onStart();
  }

  private _onSBUpdateEnd (type: SourceBufferName) {
    const { operationQueue } = this;
    const operation = operationQueue.current(type);
    operation.onComplete();
    operationQueue.shiftAndExecuteNext(type);
  }

  private _onSBUpdateError (type: SourceBufferName, event: Event) {
    logger.error(`[buffer-controller]: ${type} SourceBuffer error`, event);
    // according to http://www.w3.org/TR/media-source/#sourcebuffer-append-error
    // SourceBuffer errors are not necessarily fatal; if so, the HTMLMediaElement will fire an error event
    this.hls.trigger(Events.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: false });
    // updateend is always fired after error, so we'll allow that to shift the current operation off of the queue
    const operation = this.operationQueue.current(type);
    if (operation) {
      operation.onError(event);
    }
  }

  // This method must result in an updateend event; if remove is not called, _onSBUpdateEnd must be called manually
  private removeExecutor (type: SourceBufferName, startOffset: number, endOffset: number) {
    const { media, operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!media || !sb) {
      logger.warn(`[buffer-controller]: Attempting to remove from the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }

    const removeStart = Math.max(0, startOffset);
    const removeEnd = Math.min(media.duration, endOffset);
    if (removeEnd > removeStart) {
      logger.log(`[buffer-controller]: Removing [${removeStart},${removeEnd}] from the ${type} SourceBuffer`);
      console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
      sb.remove(removeStart, removeEnd);
    } else {
      // Cycle the queue
      operationQueue.shiftAndExecuteNext(type);
    }
  }

  // This method must result in an updateend event; if append is not called, _onSBUpdateEnd must be called manually
  private appendExecutor (data: Uint8Array, type: SourceBufferName) {
    const { operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!sb) {
      logger.warn(`[buffer-controller]: Attempting to append to the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }

    sb.ended = false;
    console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
    sb.appendBuffer(data);
  }

  // SourceBuffers can be aborted while the updating flag is true, but only if it is because of an append operation -
  // aborting during a remove will throw an InvalidStateError. It's safer to enqueue aborts and execute them only if
  // updating is false
  private abortExecutor (type: SourceBufferName) {
    const { operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!sb) {
      logger.warn(`[buffer-controller]: Attempting to abort to the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }
    logger.log(`[buffer-controller]: Aborting the ${type} SourceBuffer`);
    // console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
    const updating = sb.updating;
    sb.abort();
    // updateend is only triggered if aborting while updating is true
    if (!updating) {
      this._onSBUpdateEnd(type);
    }
  }

  // Enqueues an operation to each SourceBuffer queue which, upon execution, resolves a promise. When all promises
  // resolve, the onUnblocked function is executed. Functions calling this method do not need to unblock the queue
  // upon completion, since we already do it here
  private blockBuffers (onUnblocked: Function, buffers: Array<SourceBufferName> = this.getSourceBufferTypes()) {
    if (!buffers.length) {
      // logger.log('[buffer-controller]: Blocking operation requested, but no SourceBuffers exist');
      onUnblocked();
      return;
    }
    const { operationQueue } = this;

    // logger.log(`[buffer-controller]: Blocking ${buffers} SourceBuffer`);
    const blockingOperations = buffers.map(type => operationQueue.appendBlocker(type as SourceBufferName));
    Promise.all(blockingOperations).then(() => {
      // logger.log(`[buffer-controller]: Blocking operation resolved; unblocking ${buffers} SourceBuffer`);
      onUnblocked();
      buffers.forEach(type => {
        const sb = this.sourceBuffer[type];
        // Only cycle the queue if the SB is not updating. There's a bug in Chrome which sets the SB updating flag to
        // true when changing the MediaSource duration (https://bugs.chromium.org/p/chromium/issues/detail?id=959359&can=2&q=mediasource%20duration)
        // While this is a workaround, it's probably useful to have around
        if (!sb || !sb.updating) {
          operationQueue.shiftAndExecuteNext(type);
        }
      });
    });
  }

  private getSourceBufferTypes () : Array<SourceBufferName> {
    return Object.keys(this.sourceBuffer) as Array<SourceBufferName>;
  }

  private addBufferListener (type: SourceBufferName, event: string, fn: Function) {
    const buffer = this.sourceBuffer[type];
    if (!buffer) {
      return;
    }
    const listener = fn.bind(this, type);
    this.listeners[type].push({ event, listener });
    buffer.addEventListener(event, listener);
  }

  private removeBufferListeners (type: SourceBufferName) {
    const buffer = this.sourceBuffer[type];
    if (!buffer) {
      return;
    }
    this.listeners[type].forEach(l => {
      buffer.removeEventListener(l.event, l.listener);
    });
  }
}

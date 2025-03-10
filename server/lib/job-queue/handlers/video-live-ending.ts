import { Job } from 'bullmq'
import { readdir, remove } from 'fs-extra'
import { join } from 'path'
import { ffprobePromise, getAudioStream, getVideoStreamDimensionsInfo, getVideoStreamDuration } from '@server/helpers/ffmpeg'
import { getLocalVideoActivityPubUrl } from '@server/lib/activitypub/url'
import { federateVideoIfNeeded } from '@server/lib/activitypub/videos'
import { cleanupPermanentLive, cleanupTMPLiveFiles, cleanupUnsavedNormalLive } from '@server/lib/live'
import { generateHLSMasterPlaylistFilename, generateHlsSha256SegmentsFilename, getLiveReplayBaseDirectory } from '@server/lib/paths'
import { generateVideoMiniature } from '@server/lib/thumbnail'
import { generateHlsPlaylistResolutionFromTS } from '@server/lib/transcoding/transcoding'
import { moveToNextState } from '@server/lib/video-state'
import { VideoModel } from '@server/models/video/video'
import { VideoBlacklistModel } from '@server/models/video/video-blacklist'
import { VideoFileModel } from '@server/models/video/video-file'
import { VideoLiveModel } from '@server/models/video/video-live'
import { VideoLiveSessionModel } from '@server/models/video/video-live-session'
import { VideoStreamingPlaylistModel } from '@server/models/video/video-streaming-playlist'
import { MVideo, MVideoLive, MVideoLiveSession, MVideoWithAllFiles } from '@server/types/models'
import { ThumbnailType, VideoLiveEndingPayload, VideoState } from '@shared/models'
import { logger, loggerTagsFactory } from '../../../helpers/logger'

const lTags = loggerTagsFactory('live', 'job')

async function processVideoLiveEnding (job: Job) {
  const payload = job.data as VideoLiveEndingPayload

  logger.info('Processing video live ending for %s.', payload.videoId, { payload, ...lTags() })

  function logError () {
    logger.warn('Video live %d does not exist anymore. Cannot process live ending.', payload.videoId, lTags())
  }

  const video = await VideoModel.load(payload.videoId)
  const live = await VideoLiveModel.loadByVideoId(payload.videoId)
  const liveSession = await VideoLiveSessionModel.load(payload.liveSessionId)

  const permanentLive = live.permanentLive

  if (!video || !live || !liveSession) {
    logError()
    return
  }

  liveSession.endingProcessed = true
  await liveSession.save()

  if (liveSession.saveReplay !== true) {
    return cleanupLiveAndFederate({ permanentLive, video, streamingPlaylistId: payload.streamingPlaylistId })
  }

  if (permanentLive) {
    await saveReplayToExternalVideo({
      liveVideo: video,
      liveSession,
      publishedAt: payload.publishedAt,
      replayDirectory: payload.replayDirectory
    })

    return cleanupLiveAndFederate({ permanentLive, video, streamingPlaylistId: payload.streamingPlaylistId })
  }

  return replaceLiveByReplay({ video, liveSession, live, permanentLive, replayDirectory: payload.replayDirectory })
}

// ---------------------------------------------------------------------------

export {
  processVideoLiveEnding
}

// ---------------------------------------------------------------------------

async function saveReplayToExternalVideo (options: {
  liveVideo: MVideo
  liveSession: MVideoLiveSession
  publishedAt: string
  replayDirectory: string
}) {
  const { liveVideo, liveSession, publishedAt, replayDirectory } = options

  const replayVideo = new VideoModel({
    name: `${liveVideo.name} - ${new Date(publishedAt).toLocaleString()}`,
    isLive: false,
    state: VideoState.TO_TRANSCODE,
    duration: 0,

    remote: liveVideo.remote,
    category: liveVideo.category,
    licence: liveVideo.licence,
    language: liveVideo.language,
    commentsEnabled: liveVideo.commentsEnabled,
    downloadEnabled: liveVideo.downloadEnabled,
    waitTranscoding: true,
    nsfw: liveVideo.nsfw,
    description: liveVideo.description,
    support: liveVideo.support,
    privacy: liveVideo.privacy,
    channelId: liveVideo.channelId
  }) as MVideoWithAllFiles

  replayVideo.Thumbnails = []
  replayVideo.VideoFiles = []
  replayVideo.VideoStreamingPlaylists = []

  replayVideo.url = getLocalVideoActivityPubUrl(replayVideo)

  await replayVideo.save()

  liveSession.replayVideoId = replayVideo.id
  await liveSession.save()

  // If live is blacklisted, also blacklist the replay
  const blacklist = await VideoBlacklistModel.loadByVideoId(liveVideo.id)
  if (blacklist) {
    await VideoBlacklistModel.create({
      videoId: replayVideo.id,
      unfederated: blacklist.unfederated,
      reason: blacklist.reason,
      type: blacklist.type
    })
  }

  await assignReplayFilesToVideo({ video: replayVideo, replayDirectory })

  await remove(replayDirectory)

  for (const type of [ ThumbnailType.MINIATURE, ThumbnailType.PREVIEW ]) {
    const image = await generateVideoMiniature({ video: replayVideo, videoFile: replayVideo.getMaxQualityFile(), type })
    await replayVideo.addAndSaveThumbnail(image)
  }

  await moveToNextState({ video: replayVideo, isNewVideo: true })
}

async function replaceLiveByReplay (options: {
  video: MVideo
  liveSession: MVideoLiveSession
  live: MVideoLive
  permanentLive: boolean
  replayDirectory: string
}) {
  const { video, liveSession, live, permanentLive, replayDirectory } = options

  await cleanupTMPLiveFiles(video)

  await live.destroy()

  video.isLive = false
  video.waitTranscoding = true
  video.state = VideoState.TO_TRANSCODE

  await video.save()

  liveSession.replayVideoId = video.id
  await liveSession.save()

  // Remove old HLS playlist video files
  const videoWithFiles = await VideoModel.loadFull(video.id)

  const hlsPlaylist = videoWithFiles.getHLSPlaylist()
  await VideoFileModel.removeHLSFilesOfVideoId(hlsPlaylist.id)

  // Reset playlist
  hlsPlaylist.VideoFiles = []
  hlsPlaylist.playlistFilename = generateHLSMasterPlaylistFilename()
  hlsPlaylist.segmentsSha256Filename = generateHlsSha256SegmentsFilename()
  await hlsPlaylist.save()

  await assignReplayFilesToVideo({ video: videoWithFiles, replayDirectory })

  if (permanentLive) { // Remove session replay
    await remove(replayDirectory)
  } else { // We won't stream again in this live, we can delete the base replay directory
    await remove(getLiveReplayBaseDirectory(videoWithFiles))
  }

  // Regenerate the thumbnail & preview?
  if (videoWithFiles.getMiniature().automaticallyGenerated === true) {
    const miniature = await generateVideoMiniature({
      video: videoWithFiles,
      videoFile: videoWithFiles.getMaxQualityFile(),
      type: ThumbnailType.MINIATURE
    })
    await videoWithFiles.addAndSaveThumbnail(miniature)
  }

  if (videoWithFiles.getPreview().automaticallyGenerated === true) {
    const preview = await generateVideoMiniature({
      video: videoWithFiles,
      videoFile: videoWithFiles.getMaxQualityFile(),
      type: ThumbnailType.PREVIEW
    })
    await videoWithFiles.addAndSaveThumbnail(preview)
  }

  // We consider this is a new video
  await moveToNextState({ video: videoWithFiles, isNewVideo: true })
}

async function assignReplayFilesToVideo (options: {
  video: MVideo
  replayDirectory: string
}) {
  const { video, replayDirectory } = options

  let durationDone = false

  const concatenatedTsFiles = await readdir(replayDirectory)

  for (const concatenatedTsFile of concatenatedTsFiles) {
    const concatenatedTsFilePath = join(replayDirectory, concatenatedTsFile)

    const probe = await ffprobePromise(concatenatedTsFilePath)
    const { audioStream } = await getAudioStream(concatenatedTsFilePath, probe)

    const { resolution } = await getVideoStreamDimensionsInfo(concatenatedTsFilePath, probe)

    const { resolutionPlaylistPath: outputPath } = await generateHlsPlaylistResolutionFromTS({
      video,
      concatenatedTsFilePath,
      resolution,
      isAAC: audioStream?.codec_name === 'aac'
    })

    if (!durationDone) {
      video.duration = await getVideoStreamDuration(outputPath)
      await video.save()

      durationDone = true
    }
  }

  return video
}

async function cleanupLiveAndFederate (options: {
  video: MVideo
  permanentLive: boolean
  streamingPlaylistId: number
}) {
  const { permanentLive, video, streamingPlaylistId } = options

  const streamingPlaylist = await VideoStreamingPlaylistModel.loadWithVideo(streamingPlaylistId)

  if (streamingPlaylist) {
    if (permanentLive) {
      await cleanupPermanentLive(video, streamingPlaylist)
    } else {
      await cleanupUnsavedNormalLive(video, streamingPlaylist)
    }
  }

  try {
    const fullVideo = await VideoModel.loadFull(video.id)
    return federateVideoIfNeeded(fullVideo, false, undefined)
  } catch (err) {
    logger.warn('Cannot federate live after cleanup', { videoId: video.id, err })
  }
}

import { RepeatOptions } from 'bullmq'
import { randomBytes } from 'crypto'
import { invert } from 'lodash'
import { join } from 'path'
import { randomInt, root } from '@shared/core-utils'
import {
  AbuseState,
  JobType,
  VideoChannelSyncState,
  VideoImportState,
  VideoPrivacy,
  VideoRateType,
  VideoResolution,
  VideoState,
  VideoTranscodingFPS
} from '../../shared/models'
import { ActivityPubActorType } from '../../shared/models/activitypub'
import { ActorImageType, FollowState } from '../../shared/models/actors'
import { NSFWPolicyType } from '../../shared/models/videos/nsfw-policy.type'
import { VideoPlaylistPrivacy } from '../../shared/models/videos/playlist/video-playlist-privacy.model'
import { VideoPlaylistType } from '../../shared/models/videos/playlist/video-playlist-type.model'
// Do not use barrels, remain constants as independent as possible
import { isTestInstance, isTestOrDevInstance, parseDurationToMs, sanitizeHost, sanitizeUrl } from '../helpers/core-utils'
import { CONFIG, registerConfigChangedHandler } from './config'

// ---------------------------------------------------------------------------

const LAST_MIGRATION_VERSION = 735

// ---------------------------------------------------------------------------

const API_VERSION = 'v1'
const PEERTUBE_VERSION: string = require(join(root(), 'package.json')).version

const PAGINATION = {
  GLOBAL: {
    COUNT: {
      DEFAULT: 15,
      MAX: 100
    }
  },
  OUTBOX: {
    COUNT: {
      MAX: 50
    }
  }
}

const WEBSERVER = {
  URL: '',
  HOST: '',
  SCHEME: '',
  WS: '',
  HOSTNAME: '',
  PORT: 0,
  RTMP_URL: '',
  RTMPS_URL: ''
}

// Sortable columns per schema
const SORTABLE_COLUMNS = {
  ADMIN_USERS: [ 'id', 'username', 'videoQuotaUsed', 'createdAt', 'lastLoginDate', 'role' ],
  USER_SUBSCRIPTIONS: [ 'id', 'createdAt' ],
  ACCOUNTS: [ 'createdAt' ],
  JOBS: [ 'createdAt' ],
  VIDEO_CHANNELS: [ 'id', 'name', 'updatedAt', 'createdAt' ],
  VIDEO_IMPORTS: [ 'createdAt' ],
  VIDEO_CHANNEL_SYNCS: [ 'externalChannelUrl', 'videoChannel', 'createdAt', 'lastSyncAt', 'state' ],

  VIDEO_COMMENT_THREADS: [ 'createdAt', 'totalReplies' ],
  VIDEO_COMMENTS: [ 'createdAt' ],

  VIDEO_RATES: [ 'createdAt' ],
  BLACKLISTS: [ 'id', 'name', 'duration', 'views', 'likes', 'dislikes', 'uuid', 'createdAt' ],

  INSTANCE_FOLLOWERS: [ 'createdAt', 'state', 'score' ],
  INSTANCE_FOLLOWING: [ 'createdAt', 'redundancyAllowed', 'state' ],
  ACCOUNT_FOLLOWERS: [ 'createdAt' ],
  CHANNEL_FOLLOWERS: [ 'createdAt' ],

  VIDEOS: [ 'name', 'duration', 'createdAt', 'publishedAt', 'originallyPublishedAt', 'views', 'likes', 'trending', 'hot', 'best' ],

  // Don't forget to update peertube-search-index with the same values
  VIDEOS_SEARCH: [ 'name', 'duration', 'createdAt', 'publishedAt', 'originallyPublishedAt', 'views', 'likes', 'match' ],
  VIDEO_CHANNELS_SEARCH: [ 'match', 'displayName', 'createdAt' ],
  VIDEO_PLAYLISTS_SEARCH: [ 'match', 'displayName', 'createdAt' ],

  ABUSES: [ 'id', 'createdAt', 'state' ],

  ACCOUNTS_BLOCKLIST: [ 'createdAt' ],
  SERVERS_BLOCKLIST: [ 'createdAt' ],

  USER_NOTIFICATIONS: [ 'createdAt', 'read' ],

  VIDEO_PLAYLISTS: [ 'name', 'displayName', 'createdAt', 'updatedAt' ],

  PLUGINS: [ 'name', 'createdAt', 'updatedAt' ],

  AVAILABLE_PLUGINS: [ 'npmName', 'popularity' ],

  VIDEO_REDUNDANCIES: [ 'name' ]
}

const OAUTH_LIFETIME = {
  ACCESS_TOKEN: 3600 * 24, // 1 day, for upload
  REFRESH_TOKEN: 1209600 // 2 weeks
}

const ROUTE_CACHE_LIFETIME = {
  FEEDS: '15 minutes',
  ROBOTS: '2 hours',
  SITEMAP: '1 day',
  SECURITYTXT: '2 hours',
  NODEINFO: '10 minutes',
  DNT_POLICY: '1 week',
  ACTIVITY_PUB: {
    VIDEOS: '1 second' // 1 second, cache concurrent requests after a broadcast for example
  },
  STATS: '4 hours'
}

// ---------------------------------------------------------------------------

// Number of points we add/remove after a successful/bad request
const ACTOR_FOLLOW_SCORE = {
  PENALTY: -10,
  BONUS: 10,
  BASE: 1000,
  MAX: 10000
}

const FOLLOW_STATES: { [ id: string ]: FollowState } = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected'
}

const REMOTE_SCHEME = {
  HTTP: 'https',
  WS: 'wss'
}

const JOB_ATTEMPTS: { [id in JobType]: number } = {
  'activitypub-http-broadcast': 1,
  'activitypub-http-broadcast-parallel': 1,
  'activitypub-http-unicast': 1,
  'activitypub-http-fetcher': 2,
  'activitypub-follow': 5,
  'activitypub-cleaner': 1,
  'video-file-import': 1,
  'video-transcoding': 1,
  'video-import': 1,
  'email': 5,
  'actor-keys': 3,
  'videos-views-stats': 1,
  'activitypub-refresher': 1,
  'video-redundancy': 1,
  'video-live-ending': 1,
  'video-studio-edition': 1,
  'manage-video-torrent': 1,
  'video-channel-import': 1,
  'after-video-channel-import': 1,
  'move-to-object-storage': 3,
  'notify': 1,
  'federate-video': 1
}
// Excluded keys are jobs that can be configured by admins
const JOB_CONCURRENCY: { [id in Exclude<JobType, 'video-transcoding' | 'video-import'>]: number } = {
  'activitypub-http-broadcast': 1,
  'activitypub-http-broadcast-parallel': 30,
  'activitypub-http-unicast': 10,
  'activitypub-http-fetcher': 3,
  'activitypub-cleaner': 1,
  'activitypub-follow': 1,
  'video-file-import': 1,
  'email': 5,
  'actor-keys': 1,
  'videos-views-stats': 1,
  'activitypub-refresher': 1,
  'video-redundancy': 1,
  'video-live-ending': 10,
  'video-studio-edition': 1,
  'manage-video-torrent': 1,
  'move-to-object-storage': 1,
  'video-channel-import': 1,
  'after-video-channel-import': 1,
  'notify': 5,
  'federate-video': 3
}
const JOB_TTL: { [id in JobType]: number } = {
  'activitypub-http-broadcast': 60000 * 10, // 10 minutes
  'activitypub-http-broadcast-parallel': 60000 * 10, // 10 minutes
  'activitypub-http-unicast': 60000 * 10, // 10 minutes
  'activitypub-http-fetcher': 1000 * 3600 * 10, // 10 hours
  'activitypub-follow': 60000 * 10, // 10 minutes
  'activitypub-cleaner': 1000 * 3600, // 1 hour
  'video-file-import': 1000 * 3600, // 1 hour
  'video-transcoding': 1000 * 3600 * 48, // 2 days, transcoding could be long
  'video-studio-edition': 1000 * 3600 * 10, // 10 hours
  'video-import': CONFIG.IMPORT.VIDEOS.TIMEOUT,
  'email': 60000 * 10, // 10 minutes
  'actor-keys': 60000 * 20, // 20 minutes
  'videos-views-stats': undefined, // Unlimited
  'activitypub-refresher': 60000 * 10, // 10 minutes
  'video-redundancy': 1000 * 3600 * 3, // 3 hours
  'video-live-ending': 1000 * 60 * 10, // 10 minutes
  'manage-video-torrent': 1000 * 3600 * 3, // 3 hours
  'move-to-object-storage': 1000 * 60 * 60 * 3, // 3 hours
  'video-channel-import': 1000 * 60 * 60 * 4, // 4 hours
  'after-video-channel-import': 60000 * 5, // 5 minutes
  'notify': 60000 * 5, // 5 minutes
  'federate-video': 60000 * 5 // 5 minutes
}
const REPEAT_JOBS: { [ id in JobType ]?: RepeatOptions } = {
  'videos-views-stats': {
    cron: randomInt(1, 20) + ' * * * *' // Between 1-20 minutes past the hour
  },
  'activitypub-cleaner': {
    cron: '30 5 * * ' + randomInt(0, 7) // 1 time per week (random day) at 5:30 AM
  }
}
const JOB_PRIORITY = {
  TRANSCODING: 100
}

const BROADCAST_CONCURRENCY = 30 // How many requests in parallel we do in activitypub-http-broadcast job
const CRAWL_REQUEST_CONCURRENCY = 1 // How many requests in parallel to fetch remote data (likes, shares...)

const AP_CLEANER = {
  CONCURRENCY: 10, // How many requests in parallel we do in activitypub-cleaner job
  UNAVAILABLE_TRESHOLD: 3, // How many attempts we do before removing an unavailable remote resource
  PERIOD: parseDurationToMs('1 week') // /!\ Has to be sync with REPEAT_JOBS
}

const REQUEST_TIMEOUTS = {
  DEFAULT: 7000, // 7 seconds
  FILE: 30000, // 30 seconds
  REDUNDANCY: JOB_TTL['video-redundancy']
}

const JOB_COMPLETED_LIFETIME = 60000 * 60 * 24 * 2 // 2 days
const VIDEO_IMPORT_TIMEOUT = Math.floor(JOB_TTL['video-import'] * 0.9)

const SCHEDULER_INTERVALS_MS = {
  ACTOR_FOLLOW_SCORES: 60000 * 60, // 1 hour
  REMOVE_OLD_JOBS: 60000 * 60, // 1 hour
  UPDATE_VIDEOS: 60000, // 1 minute
  YOUTUBE_DL_UPDATE: 60000 * 60 * 24, // 1 day
  GEO_IP_UPDATE: 60000 * 60 * 24, // 1 day
  VIDEO_VIEWS_BUFFER_UPDATE: CONFIG.VIEWS.VIDEOS.LOCAL_BUFFER_UPDATE_INTERVAL,
  CHECK_PLUGINS: CONFIG.PLUGINS.INDEX.CHECK_LATEST_VERSIONS_INTERVAL,
  CHECK_PEERTUBE_VERSION: 60000 * 60 * 24, // 1 day
  AUTO_FOLLOW_INDEX_INSTANCES: 60000 * 60 * 24, // 1 day
  REMOVE_OLD_VIEWS: 60000 * 60 * 24, // 1 day
  REMOVE_OLD_HISTORY: 60000 * 60 * 24, // 1 day
  UPDATE_INBOX_STATS: 1000 * 60, // 1 minute
  REMOVE_DANGLING_RESUMABLE_UPLOADS: 60000 * 60, // 1 hour
  CHANNEL_SYNC_CHECK_INTERVAL: CONFIG.IMPORT.VIDEO_CHANNEL_SYNCHRONIZATION.CHECK_INTERVAL
}

// ---------------------------------------------------------------------------

const CONSTRAINTS_FIELDS = {
  USERS: {
    NAME: { min: 1, max: 120 }, // Length
    DESCRIPTION: { min: 3, max: 1000 }, // Length
    USERNAME: { min: 1, max: 50 }, // Length
    PASSWORD: { min: 6, max: 255 }, // Length
    VIDEO_QUOTA: { min: -1 },
    VIDEO_QUOTA_DAILY: { min: -1 },
    VIDEO_LANGUAGES: { max: 500 }, // Array length
    BLOCKED_REASON: { min: 3, max: 250 } // Length
  },
  ABUSES: {
    REASON: { min: 2, max: 3000 }, // Length
    MODERATION_COMMENT: { min: 2, max: 3000 } // Length
  },
  ABUSE_MESSAGES: {
    MESSAGE: { min: 2, max: 3000 } // Length
  },
  VIDEO_BLACKLIST: {
    REASON: { min: 2, max: 300 } // Length
  },
  VIDEO_CHANNELS: {
    NAME: { min: 1, max: 120 }, // Length
    DESCRIPTION: { min: 3, max: 1000 }, // Length
    SUPPORT: { min: 3, max: 1000 }, // Length
    EXTERNAL_CHANNEL_URL: { min: 3, max: 2000 }, // Length
    URL: { min: 3, max: 2000 } // Length
  },
  VIDEO_CHANNEL_SYNCS: {
    EXTERNAL_CHANNEL_URL: { min: 3, max: 2000 } // Length
  },
  VIDEO_CAPTIONS: {
    CAPTION_FILE: {
      EXTNAME: [ '.vtt', '.srt' ],
      FILE_SIZE: {
        max: 20 * 1024 * 1024 // 20MB
      }
    }
  },
  VIDEO_IMPORTS: {
    URL: { min: 3, max: 2000 }, // Length
    TORRENT_NAME: { min: 3, max: 255 }, // Length
    TORRENT_FILE: {
      EXTNAME: [ '.torrent' ],
      FILE_SIZE: {
        max: 1024 * 200 // 200 KB
      }
    }
  },
  VIDEOS_REDUNDANCY: {
    URL: { min: 3, max: 2000 } // Length
  },
  VIDEO_RATES: {
    URL: { min: 3, max: 2000 } // Length
  },
  VIDEOS: {
    NAME: { min: 3, max: 120 }, // Length
    LANGUAGE: { min: 1, max: 10 }, // Length
    TRUNCATED_DESCRIPTION: { min: 3, max: 250 }, // Length
    DESCRIPTION: { min: 3, max: 10000 }, // Length
    SUPPORT: { min: 3, max: 1000 }, // Length
    IMAGE: {
      EXTNAME: [ '.png', '.jpg', '.jpeg', '.webp' ],
      FILE_SIZE: {
        max: 4 * 1024 * 1024 // 4MB
      }
    },
    EXTNAME: [] as string[],
    INFO_HASH: { min: 40, max: 40 }, // Length, info hash is 20 bytes length but we represent it in hexadecimal so 20 * 2
    DURATION: { min: 0 }, // Number
    TAGS: { min: 0, max: 5 }, // Number of total tags
    TAG: { min: 2, max: 30 }, // Length
    VIEWS: { min: 0 },
    LIKES: { min: 0 },
    DISLIKES: { min: 0 },
    FILE_SIZE: { min: -1 },
    PARTIAL_UPLOAD_SIZE: { max: 50 * 1024 * 1024 * 1024 }, // 50GB
    URL: { min: 3, max: 2000 } // Length
  },
  VIDEO_PLAYLISTS: {
    NAME: { min: 1, max: 120 }, // Length
    DESCRIPTION: { min: 3, max: 1000 }, // Length
    URL: { min: 3, max: 2000 }, // Length
    IMAGE: {
      EXTNAME: [ '.jpg', '.jpeg' ],
      FILE_SIZE: {
        max: 4 * 1024 * 1024 // 4MB
      }
    }
  },
  ACTORS: {
    PUBLIC_KEY: { min: 10, max: 5000 }, // Length
    PRIVATE_KEY: { min: 10, max: 5000 }, // Length
    URL: { min: 3, max: 2000 }, // Length
    IMAGE: {
      EXTNAME: [ '.png', '.jpeg', '.jpg', '.gif', '.webp' ],
      FILE_SIZE: {
        max: 4 * 1024 * 1024 // 4MB
      }
    }
  },
  VIDEO_EVENTS: {
    COUNT: { min: 0 }
  },
  VIDEO_COMMENTS: {
    TEXT: { min: 1, max: 10000 }, // Length
    URL: { min: 3, max: 2000 } // Length
  },
  VIDEO_SHARE: {
    URL: { min: 3, max: 2000 } // Length
  },
  CONTACT_FORM: {
    FROM_NAME: { min: 1, max: 120 }, // Length
    BODY: { min: 3, max: 5000 } // Length
  },
  PLUGINS: {
    NAME: { min: 1, max: 214 }, // Length
    DESCRIPTION: { min: 1, max: 20000 } // Length
  },
  COMMONS: {
    URL: { min: 5, max: 2000 } // Length
  },
  VIDEO_STUDIO: {
    TASKS: { min: 1, max: 10 }, // Number of tasks
    CUT_TIME: { min: 0 } // Value
  },
  LOGS: {
    CLIENT_MESSAGE: { min: 1, max: 1000 }, // Length
    CLIENT_STACK_TRACE: { min: 1, max: 15000 }, // Length
    CLIENT_META: { min: 1, max: 5000 }, // Length
    CLIENT_USER_AGENT: { min: 1, max: 200 } // Length
  }
}

const VIEW_LIFETIME = {
  VIEW: CONFIG.VIEWS.VIDEOS.IP_VIEW_EXPIRATION,
  VIEWER_COUNTER: 60000 * 2, // 2 minutes
  VIEWER_STATS: 60000 * 60 // 1 hour
}

const MAX_LOCAL_VIEWER_WATCH_SECTIONS = 100

let CONTACT_FORM_LIFETIME = 60000 * 60 // 1 hour

const VIDEO_TRANSCODING_FPS: VideoTranscodingFPS = {
  MIN: 1,
  STANDARD: [ 24, 25, 30 ],
  HD_STANDARD: [ 50, 60 ],
  AUDIO_MERGE: 25,
  AVERAGE: 30,
  MAX: 60,
  KEEP_ORIGIN_FPS_RESOLUTION_MIN: 720 // We keep the original FPS on high resolutions (720 minimum)
}

const DEFAULT_AUDIO_RESOLUTION = VideoResolution.H_480P

const VIDEO_RATE_TYPES: { [ id: string ]: VideoRateType } = {
  LIKE: 'like',
  DISLIKE: 'dislike'
}

const FFMPEG_NICE: { [ id: string ]: number } = {
  // parent process defaults to niceness = 0
  // reminder: lower = higher priority, max value is 19, lowest is -20
  LIVE: 5, // prioritize over VOD and THUMBNAIL
  THUMBNAIL: 10,
  VOD: 15
}

const VIDEO_CATEGORIES = {
  1: 'Music',
  2: 'Films',
  3: 'Vehicles',
  4: 'Art',
  5: 'Sports',
  6: 'Travels',
  7: 'Gaming',
  8: 'People',
  9: 'Comedy',
  10: 'Entertainment',
  11: 'News & Politics',
  12: 'How To',
  13: 'Education',
  14: 'Activism',
  15: 'Science & Technology',
  16: 'Animals',
  17: 'Kids',
  18: 'Food'
}

// See https://creativecommons.org/licenses/?lang=en
const VIDEO_LICENCES = {
  1: 'Attribution',
  2: 'Attribution - Share Alike',
  3: 'Attribution - No Derivatives',
  4: 'Attribution - Non Commercial',
  5: 'Attribution - Non Commercial - Share Alike',
  6: 'Attribution - Non Commercial - No Derivatives',
  7: 'Public Domain Dedication'
}

const VIDEO_LANGUAGES: { [id: string]: string } = {}

const VIDEO_PRIVACIES: { [ id in VideoPrivacy ]: string } = {
  [VideoPrivacy.PUBLIC]: 'Public',
  [VideoPrivacy.UNLISTED]: 'Unlisted',
  [VideoPrivacy.PRIVATE]: 'Private',
  [VideoPrivacy.INTERNAL]: 'Internal'
}

const VIDEO_STATES: { [ id in VideoState ]: string } = {
  [VideoState.PUBLISHED]: 'Published',
  [VideoState.TO_TRANSCODE]: 'To transcode',
  [VideoState.TO_IMPORT]: 'To import',
  [VideoState.WAITING_FOR_LIVE]: 'Waiting for livestream',
  [VideoState.LIVE_ENDED]: 'Livestream ended',
  [VideoState.TO_MOVE_TO_EXTERNAL_STORAGE]: 'To move to an external storage',
  [VideoState.TRANSCODING_FAILED]: 'Transcoding failed',
  [VideoState.TO_MOVE_TO_EXTERNAL_STORAGE_FAILED]: 'External storage move failed',
  [VideoState.TO_EDIT]: 'To edit*'
}

const VIDEO_IMPORT_STATES: { [ id in VideoImportState ]: string } = {
  [VideoImportState.FAILED]: 'Failed',
  [VideoImportState.PENDING]: 'Pending',
  [VideoImportState.SUCCESS]: 'Success',
  [VideoImportState.REJECTED]: 'Rejected',
  [VideoImportState.CANCELLED]: 'Cancelled',
  [VideoImportState.PROCESSING]: 'Processing'
}

const VIDEO_CHANNEL_SYNC_STATE: { [ id in VideoChannelSyncState ]: string } = {
  [VideoChannelSyncState.FAILED]: 'Failed',
  [VideoChannelSyncState.SYNCED]: 'Synchronized',
  [VideoChannelSyncState.PROCESSING]: 'Processing',
  [VideoChannelSyncState.WAITING_FIRST_RUN]: 'Waiting first run'
}

const ABUSE_STATES: { [ id in AbuseState ]: string } = {
  [AbuseState.PENDING]: 'Pending',
  [AbuseState.REJECTED]: 'Rejected',
  [AbuseState.ACCEPTED]: 'Accepted'
}

const VIDEO_PLAYLIST_PRIVACIES: { [ id in VideoPlaylistPrivacy ]: string } = {
  [VideoPlaylistPrivacy.PUBLIC]: 'Public',
  [VideoPlaylistPrivacy.UNLISTED]: 'Unlisted',
  [VideoPlaylistPrivacy.PRIVATE]: 'Private'
}

const VIDEO_PLAYLIST_TYPES: { [ id in VideoPlaylistType ]: string } = {
  [VideoPlaylistType.REGULAR]: 'Regular',
  [VideoPlaylistType.WATCH_LATER]: 'Watch later'
}

const MIMETYPES = {
  AUDIO: {
    MIMETYPE_EXT: {
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',

      'application/ogg': '.ogg',
      'audio/ogg': '.ogg',

      'audio/x-ms-wma': '.wma',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',

      'audio/x-flac': '.flac',
      'audio/flac': '.flac',

      'audio/vnd.dlna.adts': '.aac',
      'audio/aac': '.aac',

      'audio/m4a': '.m4a',
      'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a',

      'audio/vnd.dolby.dd-raw': '.ac3',
      'audio/ac3': '.ac3'
    },
    EXT_MIMETYPE: null as { [ id: string ]: string }
  },
  VIDEO: {
    MIMETYPE_EXT: null as { [ id: string ]: string | string[] },
    MIMETYPES_REGEX: null as string,
    EXT_MIMETYPE: null as { [ id: string ]: string }
  },
  IMAGE: {
    MIMETYPE_EXT: {
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/jpg': '.jpg',
      'image/jpeg': '.jpg'
    },
    EXT_MIMETYPE: null as { [ id: string ]: string }
  },
  VIDEO_CAPTIONS: {
    MIMETYPE_EXT: {
      'text/vtt': '.vtt',
      'application/x-subrip': '.srt',
      'text/plain': '.srt'
    }
  },
  TORRENT: {
    MIMETYPE_EXT: {
      'application/x-bittorrent': '.torrent'
    }
  }
}
MIMETYPES.AUDIO.EXT_MIMETYPE = invert(MIMETYPES.AUDIO.MIMETYPE_EXT)
MIMETYPES.IMAGE.EXT_MIMETYPE = invert(MIMETYPES.IMAGE.MIMETYPE_EXT)

const BINARY_CONTENT_TYPES = new Set([
  'binary/octet-stream',
  'application/octet-stream',
  'application/x-binary'
])

// ---------------------------------------------------------------------------

const OVERVIEWS = {
  VIDEOS: {
    SAMPLE_THRESHOLD: 6,
    SAMPLES_COUNT: 20
  }
}

// ---------------------------------------------------------------------------

const SERVER_ACTOR_NAME = 'peertube'

const ACTIVITY_PUB = {
  POTENTIAL_ACCEPT_HEADERS: [
    'application/activity+json',
    'application/ld+json',
    'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
  ],
  ACCEPT_HEADER: 'application/activity+json, application/ld+json',
  PUBLIC: 'https://www.w3.org/ns/activitystreams#Public',
  COLLECTION_ITEMS_PER_PAGE: 10,
  FETCH_PAGE_LIMIT: 2000,
  URL_MIME_TYPES: {
    VIDEO: [] as string[],
    TORRENT: [ 'application/x-bittorrent' ],
    MAGNET: [ 'application/x-bittorrent;x-scheme-handler/magnet' ]
  },
  MAX_RECURSION_COMMENTS: 100,
  ACTOR_REFRESH_INTERVAL: 3600 * 24 * 1000 * 2, // 2 days
  VIDEO_REFRESH_INTERVAL: 3600 * 24 * 1000 * 2, // 2 days
  VIDEO_PLAYLIST_REFRESH_INTERVAL: 3600 * 24 * 1000 * 2 // 2 days
}

const ACTIVITY_PUB_ACTOR_TYPES: { [ id: string ]: ActivityPubActorType } = {
  GROUP: 'Group',
  PERSON: 'Person',
  APPLICATION: 'Application',
  ORGANIZATION: 'Organization',
  SERVICE: 'Service'
}

const HTTP_SIGNATURE = {
  HEADER_NAME: 'signature',
  ALGORITHM: 'rsa-sha256',
  HEADERS_TO_SIGN: [ '(request-target)', 'host', 'date', 'digest' ],
  CLOCK_SKEW_SECONDS: 1800
}

// ---------------------------------------------------------------------------

let PRIVATE_RSA_KEY_SIZE = 2048

// Password encryption
const BCRYPT_SALT_SIZE = 10

const USER_PASSWORD_RESET_LIFETIME = 60000 * 60 // 60 minutes
const USER_PASSWORD_CREATE_LIFETIME = 60000 * 60 * 24 * 7 // 7 days

const USER_EMAIL_VERIFY_LIFETIME = 60000 * 60 // 60 minutes

const NSFW_POLICY_TYPES: { [ id: string ]: NSFWPolicyType } = {
  DO_NOT_LIST: 'do_not_list',
  BLUR: 'blur',
  DISPLAY: 'display'
}

// ---------------------------------------------------------------------------

// Express static paths (router)
const STATIC_PATHS = {
  THUMBNAILS: '/static/thumbnails/',
  WEBSEED: '/static/webseed/',
  REDUNDANCY: '/static/redundancy/',
  STREAMING_PLAYLISTS: {
    HLS: '/static/streaming-playlists/hls'
  }
}
const STATIC_DOWNLOAD_PATHS = {
  TORRENTS: '/download/torrents/',
  VIDEOS: '/download/videos/',
  HLS_VIDEOS: '/download/streaming-playlists/hls/videos/'
}
const LAZY_STATIC_PATHS = {
  BANNERS: '/lazy-static/banners/',
  AVATARS: '/lazy-static/avatars/',
  PREVIEWS: '/lazy-static/previews/',
  VIDEO_CAPTIONS: '/lazy-static/video-captions/',
  TORRENTS: '/lazy-static/torrents/'
}

// Cache control
const STATIC_MAX_AGE = {
  SERVER: '2h',
  LAZY_SERVER: '2d',
  CLIENT: '30d'
}

// Videos thumbnail size
const THUMBNAILS_SIZE = {
  width: 280,
  height: 157,
  minWidth: 150
}
const PREVIEWS_SIZE = {
  width: 850,
  height: 480,
  minWidth: 400
}
const ACTOR_IMAGES_SIZE: { [key in ActorImageType]: { width: number, height: number }[]} = {
  [ActorImageType.AVATAR]: [
    {
      width: 120,
      height: 120
    },
    {
      width: 48,
      height: 48
    }
  ],
  [ActorImageType.BANNER]: [
    {
      width: 1920,
      height: 317 // 6/1 ratio
    }
  ]
}

const EMBED_SIZE = {
  width: 560,
  height: 315
}

// Sub folders of cache directory
const FILES_CACHE = {
  PREVIEWS: {
    DIRECTORY: join(CONFIG.STORAGE.CACHE_DIR, 'previews'),
    MAX_AGE: 1000 * 3600 * 3 // 3 hours
  },
  VIDEO_CAPTIONS: {
    DIRECTORY: join(CONFIG.STORAGE.CACHE_DIR, 'video-captions'),
    MAX_AGE: 1000 * 3600 * 3 // 3 hours
  },
  TORRENTS: {
    DIRECTORY: join(CONFIG.STORAGE.CACHE_DIR, 'torrents'),
    MAX_AGE: 1000 * 3600 * 3 // 3 hours
  }
}

const LRU_CACHE = {
  USER_TOKENS: {
    MAX_SIZE: 1000
  },
  ACTOR_IMAGE_STATIC: {
    MAX_SIZE: 500
  }
}

const RESUMABLE_UPLOAD_DIRECTORY = join(CONFIG.STORAGE.TMP_DIR, 'resumable-uploads')
const HLS_STREAMING_PLAYLIST_DIRECTORY = join(CONFIG.STORAGE.STREAMING_PLAYLISTS_DIR, 'hls')
const HLS_REDUNDANCY_DIRECTORY = join(CONFIG.STORAGE.REDUNDANCY_DIR, 'hls')

const RESUMABLE_UPLOAD_SESSION_LIFETIME = SCHEDULER_INTERVALS_MS.REMOVE_DANGLING_RESUMABLE_UPLOADS

const VIDEO_LIVE = {
  EXTENSION: '.ts',
  CLEANUP_DELAY: 1000 * 60 * 5, // 5 minutes
  SEGMENT_TIME_SECONDS: {
    DEFAULT_LATENCY: 4, // 4 seconds
    SMALL_LATENCY: 2 // 2 seconds
  },
  SEGMENTS_LIST_SIZE: 15, // 15 maximum segments in live playlist
  REPLAY_DIRECTORY: 'replay',
  EDGE_LIVE_DELAY_SEGMENTS_NOTIFICATION: 4,
  MAX_SOCKET_WAITING_DATA: 1024 * 1000 * 100, // 100MB
  RTMP: {
    CHUNK_SIZE: 60000,
    GOP_CACHE: true,
    PING: 60,
    PING_TIMEOUT: 30,
    BASE_PATH: 'live'
  }
}

const MEMOIZE_TTL = {
  OVERVIEWS_SAMPLE: 1000 * 3600 * 4, // 4 hours
  INFO_HASH_EXISTS: 1000 * 3600 * 12, // 12 hours
  VIDEO_DURATION: 1000 * 10, // 10 seconds
  LIVE_ABLE_TO_UPLOAD: 1000 * 60, // 1 minute
  LIVE_CHECK_SOCKET_HEALTH: 1000 * 60, // 1 minute
  GET_STATS_FOR_OPEN_TELEMETRY_METRICS: 1000 * 60 // 1 minute
}

const MEMOIZE_LENGTH = {
  INFO_HASH_EXISTS: 200,
  VIDEO_DURATION: 200
}

const WORKER_THREADS = {
  DOWNLOAD_IMAGE: {
    CONCURRENCY: 3,
    MAX_THREADS: 1
  },
  PROCESS_IMAGE: {
    CONCURRENCY: 1,
    MAX_THREADS: 5
  }
}

const REDUNDANCY = {
  VIDEOS: {
    RANDOMIZED_FACTOR: 5
  }
}

const ACCEPT_HEADERS = [ 'html', 'application/json' ].concat(ACTIVITY_PUB.POTENTIAL_ACCEPT_HEADERS)

const ASSETS_PATH = {
  DEFAULT_AUDIO_BACKGROUND: join(root(), 'dist', 'server', 'assets', 'default-audio-background.jpg'),
  DEFAULT_LIVE_BACKGROUND: join(root(), 'dist', 'server', 'assets', 'default-live-background.jpg')
}

// ---------------------------------------------------------------------------

const CUSTOM_HTML_TAG_COMMENTS = {
  TITLE: '<!-- title tag -->',
  DESCRIPTION: '<!-- description tag -->',
  CUSTOM_CSS: '<!-- custom css tag -->',
  META_TAGS: '<!-- meta tags -->',
  SERVER_CONFIG: '<!-- server config -->'
}

const MAX_LOGS_OUTPUT_CHARACTERS = 10 * 1000 * 1000
const LOG_FILENAME = 'peertube.log'
const AUDIT_LOG_FILENAME = 'peertube-audit.log'

// ---------------------------------------------------------------------------

const TRACKER_RATE_LIMITS = {
  INTERVAL: 60000 * 5, // 5 minutes
  ANNOUNCES_PER_IP_PER_INFOHASH: 15, // maximum announces per torrent in the interval
  ANNOUNCES_PER_IP: 30, // maximum announces for all our torrents in the interval
  BLOCK_IP_LIFETIME: 60000 * 3 // 3 minutes
}

const P2P_MEDIA_LOADER_PEER_VERSION = 2

// ---------------------------------------------------------------------------

const PLUGIN_GLOBAL_CSS_FILE_NAME = 'plugins-global.css'
const PLUGIN_GLOBAL_CSS_PATH = join(CONFIG.STORAGE.TMP_DIR, PLUGIN_GLOBAL_CSS_FILE_NAME)

let PLUGIN_EXTERNAL_AUTH_TOKEN_LIFETIME = 1000 * 60 * 5 // 5 minutes

const DEFAULT_THEME_NAME = 'default'
const DEFAULT_USER_THEME_NAME = 'instance-default'

// ---------------------------------------------------------------------------

const SEARCH_INDEX = {
  ROUTES: {
    VIDEOS: '/api/v1/search/videos',
    VIDEO_CHANNELS: '/api/v1/search/video-channels'
  }
}

// ---------------------------------------------------------------------------

const STATS_TIMESERIE = {
  MAX_DAYS: 365 * 10 // Around 10 years
}

// ---------------------------------------------------------------------------

// Special constants for a test instance
if (process.env.PRODUCTION_CONSTANTS !== 'true') {
  if (isTestOrDevInstance()) {
    PRIVATE_RSA_KEY_SIZE = 1024

    ACTOR_FOLLOW_SCORE.BASE = 20

    REMOTE_SCHEME.HTTP = 'http'
    REMOTE_SCHEME.WS = 'ws'

    STATIC_MAX_AGE.SERVER = '0'

    SCHEDULER_INTERVALS_MS.ACTOR_FOLLOW_SCORES = 1000
    SCHEDULER_INTERVALS_MS.REMOVE_OLD_JOBS = 10000
    SCHEDULER_INTERVALS_MS.REMOVE_OLD_HISTORY = 5000
    SCHEDULER_INTERVALS_MS.REMOVE_OLD_VIEWS = 5000
    SCHEDULER_INTERVALS_MS.UPDATE_VIDEOS = 5000
    SCHEDULER_INTERVALS_MS.AUTO_FOLLOW_INDEX_INSTANCES = 5000
    SCHEDULER_INTERVALS_MS.UPDATE_INBOX_STATS = 5000
    SCHEDULER_INTERVALS_MS.CHECK_PEERTUBE_VERSION = 2000

    REPEAT_JOBS['videos-views-stats'] = { every: 5000 }

    REPEAT_JOBS['activitypub-cleaner'] = { every: 5000 }
    AP_CLEANER.PERIOD = 5000

    REDUNDANCY.VIDEOS.RANDOMIZED_FACTOR = 1

    CONTACT_FORM_LIFETIME = 1000 // 1 second

    JOB_ATTEMPTS['email'] = 1

    FILES_CACHE.VIDEO_CAPTIONS.MAX_AGE = 3000
    MEMOIZE_TTL.OVERVIEWS_SAMPLE = 3000
    MEMOIZE_TTL.LIVE_ABLE_TO_UPLOAD = 3000
    OVERVIEWS.VIDEOS.SAMPLE_THRESHOLD = 2

    PLUGIN_EXTERNAL_AUTH_TOKEN_LIFETIME = 5000
  }

  if (isTestInstance()) {
    ACTIVITY_PUB.COLLECTION_ITEMS_PER_PAGE = 2
    ACTIVITY_PUB.ACTOR_REFRESH_INTERVAL = 10 * 1000 // 10 seconds
    ACTIVITY_PUB.VIDEO_REFRESH_INTERVAL = 10 * 1000 // 10 seconds
    ACTIVITY_PUB.VIDEO_PLAYLIST_REFRESH_INTERVAL = 10 * 1000 // 10 seconds

    CONSTRAINTS_FIELDS.ACTORS.IMAGE.FILE_SIZE.max = 100 * 1024 // 100KB
    CONSTRAINTS_FIELDS.VIDEOS.IMAGE.FILE_SIZE.max = 400 * 1024 // 400KB

    VIEW_LIFETIME.VIEWER_COUNTER = 1000 * 5 // 5 second
    VIEW_LIFETIME.VIEWER_STATS = 1000 * 5 // 5 second

    VIDEO_LIVE.CLEANUP_DELAY = getIntEnv('PEERTUBE_TEST_CONSTANTS_VIDEO_LIVE_CLEANUP_DELAY') ?? 5000
    VIDEO_LIVE.SEGMENT_TIME_SECONDS.DEFAULT_LATENCY = 2
    VIDEO_LIVE.SEGMENT_TIME_SECONDS.SMALL_LATENCY = 1
    VIDEO_LIVE.EDGE_LIVE_DELAY_SEGMENTS_NOTIFICATION = 1
  }
}

updateWebserverUrls()
updateWebserverConfig()

registerConfigChangedHandler(() => {
  updateWebserverUrls()
  updateWebserverConfig()
})

// ---------------------------------------------------------------------------

const FILES_CONTENT_HASH = {
  MANIFEST: generateContentHash(),
  FAVICON: generateContentHash(),
  LOGO: generateContentHash()
}

// ---------------------------------------------------------------------------

const VIDEO_FILTERS = {
  WATERMARK: {
    SIZE_RATIO: 1 / 10,
    HORIZONTAL_MARGIN_RATIO: 1 / 20,
    VERTICAL_MARGIN_RATIO: 1 / 20
  }
}

// ---------------------------------------------------------------------------

export {
  WEBSERVER,
  API_VERSION,
  VIDEO_LIVE,
  PEERTUBE_VERSION,
  LAZY_STATIC_PATHS,
  SEARCH_INDEX,
  RESUMABLE_UPLOAD_DIRECTORY,
  RESUMABLE_UPLOAD_SESSION_LIFETIME,
  HLS_REDUNDANCY_DIRECTORY,
  P2P_MEDIA_LOADER_PEER_VERSION,
  ACTOR_IMAGES_SIZE,
  ACCEPT_HEADERS,
  BCRYPT_SALT_SIZE,
  TRACKER_RATE_LIMITS,
  FILES_CACHE,
  LOG_FILENAME,
  CONSTRAINTS_FIELDS,
  EMBED_SIZE,
  REDUNDANCY,
  JOB_CONCURRENCY,
  JOB_ATTEMPTS,
  AP_CLEANER,
  LAST_MIGRATION_VERSION,
  OAUTH_LIFETIME,
  CUSTOM_HTML_TAG_COMMENTS,
  STATS_TIMESERIE,
  BROADCAST_CONCURRENCY,
  AUDIT_LOG_FILENAME,
  PAGINATION,
  ACTOR_FOLLOW_SCORE,
  PREVIEWS_SIZE,
  REMOTE_SCHEME,
  FOLLOW_STATES,
  DEFAULT_USER_THEME_NAME,
  SERVER_ACTOR_NAME,
  PLUGIN_GLOBAL_CSS_FILE_NAME,
  PLUGIN_GLOBAL_CSS_PATH,
  PRIVATE_RSA_KEY_SIZE,
  VIDEO_FILTERS,
  ROUTE_CACHE_LIFETIME,
  SORTABLE_COLUMNS,
  HLS_STREAMING_PLAYLIST_DIRECTORY,
  JOB_TTL,
  DEFAULT_THEME_NAME,
  NSFW_POLICY_TYPES,
  STATIC_MAX_AGE,
  STATIC_PATHS,
  VIDEO_IMPORT_TIMEOUT,
  VIDEO_PLAYLIST_TYPES,
  MAX_LOGS_OUTPUT_CHARACTERS,
  ACTIVITY_PUB,
  ACTIVITY_PUB_ACTOR_TYPES,
  THUMBNAILS_SIZE,
  VIDEO_CATEGORIES,
  MEMOIZE_LENGTH,
  VIDEO_LANGUAGES,
  VIDEO_PRIVACIES,
  VIDEO_LICENCES,
  VIDEO_STATES,
  WORKER_THREADS,
  VIDEO_RATE_TYPES,
  JOB_PRIORITY,
  VIDEO_TRANSCODING_FPS,
  FFMPEG_NICE,
  ABUSE_STATES,
  LRU_CACHE,
  REQUEST_TIMEOUTS,
  MAX_LOCAL_VIEWER_WATCH_SECTIONS,
  USER_PASSWORD_RESET_LIFETIME,
  USER_PASSWORD_CREATE_LIFETIME,
  MEMOIZE_TTL,
  USER_EMAIL_VERIFY_LIFETIME,
  OVERVIEWS,
  SCHEDULER_INTERVALS_MS,
  REPEAT_JOBS,
  STATIC_DOWNLOAD_PATHS,
  MIMETYPES,
  CRAWL_REQUEST_CONCURRENCY,
  DEFAULT_AUDIO_RESOLUTION,
  BINARY_CONTENT_TYPES,
  JOB_COMPLETED_LIFETIME,
  HTTP_SIGNATURE,
  VIDEO_IMPORT_STATES,
  VIDEO_CHANNEL_SYNC_STATE,
  VIEW_LIFETIME,
  CONTACT_FORM_LIFETIME,
  VIDEO_PLAYLIST_PRIVACIES,
  PLUGIN_EXTERNAL_AUTH_TOKEN_LIFETIME,
  ASSETS_PATH,
  FILES_CONTENT_HASH,
  loadLanguages,
  buildLanguages,
  generateContentHash
}

// ---------------------------------------------------------------------------

function buildVideoMimetypeExt () {
  const data = {
    // streamable formats that warrant cross-browser compatibility
    'video/webm': '.webm',
    // We'll add .ogg if additional extensions are enabled
    // We could add .ogg here but since it could be an audio file,
    // it would be confusing for users because PeerTube will refuse their file (based on the mimetype)
    'video/ogg': [ '.ogv' ],
    'video/mp4': '.mp4'
  }

  if (CONFIG.TRANSCODING.ENABLED) {
    if (CONFIG.TRANSCODING.ALLOW_ADDITIONAL_EXTENSIONS) {
      data['video/ogg'].push('.ogg')

      Object.assign(data, {
        'video/x-matroska': '.mkv',

        // Developed by Apple
        'video/quicktime': [ '.mov', '.qt', '.mqv' ], // often used as output format by editing software
        'video/x-m4v': '.m4v',
        'video/m4v': '.m4v',

        // Developed by the Adobe Flash Platform
        'video/x-flv': '.flv',
        'video/x-f4v': '.f4v', // replacement for flv

        // Developed by Microsoft
        'video/x-ms-wmv': '.wmv',
        'video/x-msvideo': '.avi',
        'video/avi': '.avi',

        // Developed by 3GPP
        // common video formats for cell phones
        'video/3gpp': [ '.3gp', '.3gpp' ],
        'video/3gpp2': [ '.3g2', '.3gpp2' ],

        // Developed by FFmpeg/Mplayer
        'application/x-nut': '.nut',

        // The standard video format used by many Sony and Panasonic HD camcorders.
        // It is also used for storing high definition video on Blu-ray discs.
        'video/mp2t': '.mts',
        'video/vnd.dlna.mpeg-tts': '.mts',

        'video/m2ts': '.m2ts',

        // Old formats reliant on MPEG-1/MPEG-2
        'video/mpv': '.mpv',
        'video/mpeg2': '.m2v',
        'video/mpeg': [ '.m1v', '.mpg', '.mpe', '.mpeg', '.vob' ],
        'video/dvd': '.vob',

        // Could be anything
        'application/octet-stream': null,
        'application/mxf': '.mxf' // often used as exchange format by editing software
      })
    }

    if (CONFIG.TRANSCODING.ALLOW_AUDIO_FILES) {
      Object.assign(data, MIMETYPES.AUDIO.MIMETYPE_EXT)
    }
  }

  return data
}

function updateWebserverUrls () {
  WEBSERVER.URL = sanitizeUrl(CONFIG.WEBSERVER.SCHEME + '://' + CONFIG.WEBSERVER.HOSTNAME + ':' + CONFIG.WEBSERVER.PORT)
  WEBSERVER.HOST = sanitizeHost(CONFIG.WEBSERVER.HOSTNAME + ':' + CONFIG.WEBSERVER.PORT, REMOTE_SCHEME.HTTP)
  WEBSERVER.WS = CONFIG.WEBSERVER.WS

  WEBSERVER.SCHEME = CONFIG.WEBSERVER.SCHEME
  WEBSERVER.HOSTNAME = CONFIG.WEBSERVER.HOSTNAME
  WEBSERVER.PORT = CONFIG.WEBSERVER.PORT

  const rtmpHostname = CONFIG.LIVE.RTMP.PUBLIC_HOSTNAME || CONFIG.WEBSERVER.HOSTNAME
  const rtmpsHostname = CONFIG.LIVE.RTMPS.PUBLIC_HOSTNAME || CONFIG.WEBSERVER.HOSTNAME

  WEBSERVER.RTMP_URL = 'rtmp://' + rtmpHostname + ':' + CONFIG.LIVE.RTMP.PORT + '/' + VIDEO_LIVE.RTMP.BASE_PATH
  WEBSERVER.RTMPS_URL = 'rtmps://' + rtmpsHostname + ':' + CONFIG.LIVE.RTMPS.PORT + '/' + VIDEO_LIVE.RTMP.BASE_PATH
}

function updateWebserverConfig () {
  MIMETYPES.VIDEO.MIMETYPE_EXT = buildVideoMimetypeExt()
  MIMETYPES.VIDEO.MIMETYPES_REGEX = buildMimetypesRegex(MIMETYPES.VIDEO.MIMETYPE_EXT)

  ACTIVITY_PUB.URL_MIME_TYPES.VIDEO = Object.keys(MIMETYPES.VIDEO.MIMETYPE_EXT)

  MIMETYPES.VIDEO.EXT_MIMETYPE = buildVideoExtMimetype(MIMETYPES.VIDEO.MIMETYPE_EXT)

  CONSTRAINTS_FIELDS.VIDEOS.EXTNAME = Object.keys(MIMETYPES.VIDEO.EXT_MIMETYPE)
}

function buildVideoExtMimetype (obj: { [ id: string ]: string | string[] }) {
  const result: { [id: string]: string } = {}

  for (const mimetype of Object.keys(obj)) {
    const value = obj[mimetype]
    if (!value) continue

    const extensions = Array.isArray(value) ? value : [ value ]

    for (const extension of extensions) {
      result[extension] = mimetype
    }
  }

  return result
}

function buildMimetypesRegex (obj: { [id: string]: string | string[] }) {
  return Object.keys(obj)
    .map(m => `(${m})`)
    .join('|')
}

function loadLanguages () {
  Object.assign(VIDEO_LANGUAGES, buildLanguages())
}

function buildLanguages () {
  const iso639 = require('iso-639-3')

  const languages: { [id: string]: string } = {}

  const additionalLanguages = {
    sgn: true, // Sign languages (macro language)
    ase: true, // American sign language
    sdl: true, // Arabian sign language
    bfi: true, // British sign language
    bzs: true, // Brazilian sign language
    csl: true, // Chinese sign language
    cse: true, // Czech sign language
    dsl: true, // Danish sign language
    fsl: true, // French sign language
    gsg: true, // German sign language
    pks: true, // Pakistan sign language
    jsl: true, // Japanese sign language
    sfs: true, // South African sign language
    swl: true, // Swedish sign language
    rsl: true, // Russian sign language

    kab: true, // Kabyle

    lat: true, // Latin

    epo: true, // Esperanto
    tlh: true, // Klingon
    jbo: true, // Lojban
    avk: true, // Kotava

    zxx: true // No linguistic content (ISO-639-2)
  }

  // Only add ISO639-1 languages and some sign languages (ISO639-3)
  iso639
    .filter(l => {
      return (l.iso6391 !== undefined && l.type === 'living') ||
        additionalLanguages[l.iso6393] === true
    })
    .forEach(l => { languages[l.iso6391 || l.iso6393] = l.name })

  // Override Occitan label
  languages['oc'] = 'Occitan'
  languages['el'] = 'Greek'
  languages['tok'] = 'Toki Pona'

  // Chinese languages
  languages['zh-Hans'] = 'Simplified Chinese'
  languages['zh-Hant'] = 'Traditional Chinese'

  return languages
}

function generateContentHash () {
  return randomBytes(20).toString('hex')
}

function getIntEnv (path: string) {
  if (process.env[path]) return parseInt(process.env[path])

  return undefined
}

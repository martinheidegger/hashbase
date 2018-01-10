const express = require('express')
const path = require('path')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const expressValidator = require('express-validator')
const RateLimit = require('express-rate-limit')
const csurf = require('csurf')
const vhost = require('vhost')
const bytes = require('bytes')
const lessExpress = require('less-express')
const ejs = require('ejs')

const Hypercloud = require('./lib')
const customValidators = require('./lib/validators')
const customSanitizers = require('./lib/sanitizers')
const analytics = require('./lib/analytics')
const packageJson = require('./package.json')

module.exports = function (config) {
  addConfigHelpers(config)
  var cloud = new Hypercloud(config)
  cloud.version = packageJson.version
  cloud.setupAdminUser()

  var app = express()
  if (config.proxy) {
    app.set('trust proxy', 'loopback')
  }
  app.cloud = cloud
  app.config = config
  app.approveDomains = approveDomains(config, cloud)

  app.locals = {
    session: false, // default session value
    sessionUser: false,
    errors: false, // common default value
    appInfo: {
      version: cloud.version,
      brandname: config.brandname,
      hostname: config.hostname,
      port: config.port,
      proDiskUsageLimit: config.proDiskUsageLimit
    }
  }

  app.engine('html', ejs.renderFile)
  app.engine('ejs', ejs.renderFile)
  app.set('view engine', 'html')
  app.set('views', path.join(__dirname, 'assets/html'))

  app.use(cookieParser())
  app.use(bodyParser.json())
  app.use(expressValidator({ customValidators, customSanitizers }))
  app.use(cloud.sessions.middleware())
  if (config.rateLimiting) {
    app.use(new RateLimit({windowMs: 10e3, max: 100, delayMs: 0})) // general rate limit
    // app.use('/v1/verify', actionLimiter(24, 'Too many accounts created from this IP, please try again after an hour'))
    app.use('/v1/login', actionLimiter(60 * 60 * 1000, 5, 'Too many login attempts from this IP, please try again after an hour'))
  }

  // monitoring
  // =

  if (config.pm2) {
    let pmx = require('pmx')
    pmx.init({
      http: true, // HTTP routes logging (default: true)
      ignore_routes: [], // Ignore http routes with this pattern (Default: [])
      errors: true, // Exceptions logging (default: true)
      custom_probes: true, // Auto expose JS Loop Latency and HTTP req/s as custom metrics
      network: true, // Network monitoring at the application level
      ports: true  // Shows which ports your app is listening on (default: false)
    })
    require('./lib/monitoring').init(config, cloud, pmx)
  }

  // http gateway
  // =

  if (config.sites) {
    var httpGatewayApp = express()
    httpGatewayApp.locals = app.locals
    httpGatewayApp.engine('html', ejs.renderFile)
    httpGatewayApp.set('view engine', 'html')
    httpGatewayApp.set('views', path.join(__dirname, 'assets/html'))
    httpGatewayApp.get('/.well-known/dat', cloud.api.archiveFiles.getDNSFile)
    httpGatewayApp.get('*', cloud.api.archiveFiles.getFile)
    httpGatewayApp.use((err, req, res, next) => {
      if (err) {
        res.json(err.body || err)
      } else {
        next()
      }
    })
    app.use(vhost('*.' + config.hostname, httpGatewayApp))
  }

  // assets
  // =

  app.get('/assets/css/main.css', lessExpress(path.join(__dirname, 'assets/css/main.less')))

  // css for individual pages
  app.get('/assets/css/about.css', lessExpress(path.join(__dirname, 'assets/css/pages/about.less')))
  app.get('/assets/css/account.css', lessExpress(path.join(__dirname, 'assets/css/pages/account.less')))
  app.get('/assets/css/admin-dashboard.css', lessExpress(path.join(__dirname, 'assets/css/pages/admin-dashboard.less')))
  app.get('/assets/css/archive.css', lessExpress(path.join(__dirname, 'assets/css/pages/archive.less')))
  app.get('/assets/css/error.css', lessExpress(path.join(__dirname, 'assets/css/pages/error.less')))
  app.get('/assets/css/home.css', lessExpress(path.join(__dirname, 'assets/css/pages/home.less')))
  app.get('/assets/css/pricing.css', lessExpress(path.join(__dirname, 'assets/css/pages/pricing.less')))
  app.get('/assets/css/profile.css', lessExpress(path.join(__dirname, 'assets/css/pages/profile.less')))
  app.get('/assets/css/support.css', lessExpress(path.join(__dirname, 'assets/css/pages/support.less')))

  app.use('/assets/css', express.static(path.join(__dirname, 'assets/css')))
  app.use('/assets/js', express.static(path.join(__dirname, 'assets/js')))
  app.use('/assets/fonts', express.static(path.join(__dirname, 'assets/fonts')))
  app.use('/assets/images', express.static(path.join(__dirname, 'assets/images')))

  // ----------------------------------------------------------------------------------
  // add analytics for routes declared below here
  // ----------------------------------------------------------------------------------
  app.use(analytics.middleware(cloud))

  // Create separater router for API
  const api = createApiRouter(cloud)

  // Use api routes before applying csurf middleware
  app.use('/v1', api)

  // Then apply csurf
  app.use(config.csrf ? csurf({cookie: true}) : fakeCSRF)

  // service apis
  // =

  app.get('/', cloud.api.service.frontpage)
  app.get('/v1/explore', cloud.api.service.explore)

  // pages
  // =

  app.get('/', cloud.api.pages.frontpage)
  app.get('/explore', cloud.api.pages.explore)
  app.get('/new-archive', cloud.api.pages.newArchive)
  app.get('/about', cloud.api.pages.about)
  app.get('/pricing', cloud.api.pages.pricing)
  app.get('/terms', cloud.api.pages.terms)
  app.get('/privacy', cloud.api.pages.privacy)
  app.get('/acceptable-use', cloud.api.pages.acceptableUse)
  app.get('/support', cloud.api.pages.support)
  app.get('/login', cloud.api.pages.login)
  app.get('/forgot-password', cloud.api.pages.forgotPassword)
  app.get('/reset-password', cloud.api.pages.resetPassword)
  app.get('/register', cloud.api.pages.register)
  app.get('/register/pro', cloud.api.pages.registerPro)
  app.get('/registered', cloud.api.pages.registered)
  app.get('/profile', cloud.api.pages.profileRedirect)
  app.get('/account/upgrade', cloud.api.pages.accountUpgrade)
  app.get('/account/upgraded', cloud.api.pages.accountUpgraded)
  app.get('/account/cancel-plan', cloud.api.pages.accountCancelPlan)
  app.get('/account/canceled-plan', cloud.api.pages.accountCanceledPlan)
  app.get('/account/change-password', cloud.api.pages.accountChangePassword)
  app.get('/account/update-email', cloud.api.pages.accountUpdateEmail)
  app.get('/account', cloud.api.pages.account)

  // user pages
  // =

  app.get('/:username([a-z0-9]{3,})/:archivename([a-z0-9-]{3,})', cloud.api.userContent.viewArchive)
  app.get('/:username([a-z0-9]{3,})', cloud.api.userContent.viewUser)

  // (json) error-handling fallback
  // =

  app.use((err, req, res, next) => {
    var contentType = req.accepts(['json', 'html'])
    if (!contentType) {
      return next()
    }

    // CSRF error
    if (err.code === 'EBADCSRFTOKEN') {
      return res.status(403).json({
        message: 'The form has entered an invalid state. Please refresh and try submitting again. If this persists, please contact support.',
        badCSRF: true
      })
    }
    // validation errors
    if ('isEmpty' in err) {
      return res.status(422).json({
        message: 'There were errors in your submission',
        invalidInputs: true,
        details: err.mapped()
      })
    }

    // common errors
    if ('status' in err) {
      res.status(err.status)
      if (contentType === 'json') {
        res.json(err.body)
      } else {
        try {
          res.render('error.html', { error: err })
        } catch (e) {
          // HACK
          // I cant figure out why res.render() fails sometimes
          // something about the view engine?
          // fallback to json and report the issue
          // -prf
          if (config.pm2) {
            require('pmx').emit('debug:view-render-error', {
              wasRendering: err,
              threwThis: e
            })
          }
          res.json(err.body)
        }
      }
      return
    }

    // general uncaught error
    console.error('[ERROR]', err)
    res.status(500)
    var error = {
      message: 'Internal server error',
      internalError: true
    }
    if (contentType === 'json') {
      res.json(error)
    } else {
      res.render('error', { error })
    }
  })

  // error handling
  // =

  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason)
  })

  // shutdown
  // =

  app.close = cloud.close.bind(cloud)

  return app
}
function createApiRouter (cloud) {
  const router = new express.Router()

  // user & auth apis
  // =

  router.post('/register', cloud.api.users.doRegister)
  router.all('/verify', cloud.api.users.verify)
  router.get('/account', cloud.api.users.getAccount)
  router.post('/account', cloud.api.users.updateAccount)
  router.post('/account/password', cloud.api.users.updateAccountPassword)
  router.post('/account/email', cloud.api.users.updateAccountEmail)
  router.post('/account/upgrade', cloud.api.users.upgradePlan)
  router.post('/account/register/pro', cloud.api.users.registerPro)
  router.post('/account/update-card', cloud.api.users.updateCard)
  router.post('/account/cancel-plan', cloud.api.users.cancelPlan)
  router.post('/login', cloud.api.users.doLogin)
  router.get('/logout', cloud.api.users.doLogout)
  router.post('/forgot-password', cloud.api.users.doForgotPassword)
  router.get('/users/:username([^/]{3,})', cloud.api.users.get)

  // archives apis
  // =

  router.post('/archives/add', cloud.api.archives.add)
  router.post('/archives/remove', cloud.api.archives.remove)
  router.get('/archives/:key([0-9a-f]{64})', cloud.api.archives.get)
  router.get('/users/:username([^/]{3,})/:archivename', cloud.api.archives.getByName)

  // reports apis
  router.post('/reports/add', cloud.api.reports.add)

  // admin apis
  // =

  router.get('/admin', cloud.api.admin.getDashboard)
  router.get('/admin/users', cloud.api.admin.listUsers)
  router.get('/admin/users/:id', cloud.api.admin.getUser)
  router.post('/admin/users/:id', cloud.api.admin.updateUser)
  router.post('/admin/users/:id/suspend', cloud.api.admin.suspendUser)
  router.post('/admin/users/:id/unsuspend', cloud.api.admin.unsuspendUser)
  router.post('/admin/users/:id/resend-email-confirmation', cloud.api.admin.resendEmailConfirmation)
  router.post('/admin/users/:username/send-email', cloud.api.admin.sendEmail)
  router.post('/admin/archives/:key/feature', cloud.api.admin.featureArchive)
  router.post('/admin/archives/:key/unfeature', cloud.api.admin.unfeatureArchive)
  router.get('/admin/archives/:key', cloud.api.admin.getArchive)
  router.post('/admin/archives/:key/remove', cloud.api.admin.removeArchive)
  router.get('/admin/analytics/events', cloud.api.admin.getAnalyticsEventsList)
  router.get('/admin/analytics/events-count', cloud.api.admin.getAnalyticsEventsCount)
  router.get('/admin/analytics/events-stats', cloud.api.admin.getAnalyticsEventsStats)
  router.get('/admin/analytics/cohorts', cloud.api.admin.getAnalyticsCohorts)
  router.get('/admin/reports', cloud.api.admin.getReports)
  router.get('/admin/reports/:id', cloud.api.admin.getReport)
  router.post('/admin/reports/:id', cloud.api.admin.updateReport)
  router.post('/admin/reports/:id/close', cloud.api.admin.closeReport)
  router.post('/admin/reports/:id/open', cloud.api.admin.openReport)

  return router
}
function actionLimiter (windowMs, max, message) {
  return new RateLimit({
    windowMs,
    delayMs: 0,
    max,
    message
  })
}

function addConfigHelpers (config) {
  config.getUserDiskQuota = (userRecord) => {
    return userRecord.diskQuota || bytes(config.defaultDiskUsageLimit)
  }
  config.getUserDiskQuotaPct = (userRecord) => {
    return userRecord.diskUsage / config.getUserDiskQuota(userRecord)
  }
}

function approveDomains (config, cloud) {
  var domainReg
  if (config.hostname) {
    // Dots in domains are normal but dots in a regexp would be replaced with "any character"
    var regHost = (config.hostName || '').replace(/\./g, '\\.')
    if (config.sites === 'per-archive') {
      domainReg = new RegExp(`^((.+)-([^.]+)\\.)?${regHost}$`, 'g')
    } else if (config.sites === 'per-user') {
      domainReg = new RegExp(`^(()([^.]+)\\.)?${regHost}$`, 'g')
    } else {
      domainReg = new RegExp(`^${regHost}$`, 'g')
    }
  } else {
    // Allow any domain
    domainReg = /.?/g
  }
  return async (options, certs, cb) => {
    var {domain} = options
    options.agreeTos = true
    options.email = config.letsencrypt.email

    var domainParts = domainReg.exec(domain)
    if (!domainParts) {
      return cb(new Error('invalid domain'))
    }
    var archiveName = domainParts[2]
    var userName = domainParts[3]

    try {
      if (userName) {
        var userRecord = await cloud.usersDB.getByUsername(userName)
        if (!userRecord) {
          return cb(new Error(`${userName} is not a user`))
        }
        if (archiveName) {
          var archiveRecord = userRecord.archives.find(a => a.name === archiveName)
          if (!archiveRecord) {
            return cb(new Error(`Archive ${archiveName} for user ${userName} not found!`))
          }
        }
      }
    } catch (e) {
      return cb(e)
    }
    cb(null, {options, certs})
  }
}

function fakeCSRF (req, res, next) {
  req.csrfToken = () => 'csrf is disabled'
  next()
}

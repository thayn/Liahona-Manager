// Everything the cloud manager needs in AWS, in one stack:
//
//   CloudFront (the site address)
//     /*      -> S3 bucket with the web pages (public/)
//     /api/*  -> API Gateway HTTP API -> Lambda (lib/cloud/lambda.js)
//   S3 data bucket   one workspace document, every version kept (history/undo)
//   S3 media bucket  Journey audio, images and clips (uploaded straight from browsers)
//   Cognito          accounts, invites, password resets; groups = roles
//
// Costs for a camp-sized manager are close to zero when idle: no servers run
// between requests.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, Duration, RemovalPolicy, CfnOutput, Fn } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const ROLES = [['admin', 'Everything: users, event, deleting data, camp laptop', 1],
  ['registrar', 'Sign-ups and participant details', 2],
  ['planner', 'Journeys, places, media, teams, cards', 3],
  ['leader', 'Read-only; own team details', 4]];

export class LiahonaStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const adminEmail = this.node.tryGetContext('adminEmail') || '';

    // ---------------------------------------------------------------- storage
    const dataBucket = new s3.Bucket(this, 'Data', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,           // never delete camp data with the stack
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(400) }]
    });

    const mediaBucket = new s3.Bucket(this, 'Media', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3000 }]
    });

    const siteBucket = new s3.Bucket(this, 'Site', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // ---------------------------------------------------------------- API
    const fn = new nodejs.NodejsFunction(this, 'ApiFn', {
      entry: path.join(ROOT, 'lib', 'cloud', 'lambda.js'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(29),
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        DATA_BUCKET: dataBucket.bucketName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        LIAHONA_SAMPLES: '/var/task/samples',
        NODE_OPTIONS: '--enable-source-maps'
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        mainFields: ['module', 'main'],
        banner: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
        sourceMap: true,
        externalModules: [],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (input, output) => [`mkdir -p "${output}/samples"`, `cp "${input}/samples/"*.yaml "${output}/samples/"`]
        }
      }
    });
    dataBucket.grantReadWrite(fn);
    mediaBucket.grantReadWrite(fn);

    const api = new apigw.HttpApi(this, 'Api', {
      description: 'Liahona Manager API',
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn)
    });
    // Gentle limits so a runaway script (or bot on the sign-up form) can't run up costs.
    const stage = api.defaultStage.node.defaultChild;
    stage.defaultRouteSettings = { throttlingRateLimit: 25, throttlingBurstLimit: 50 };

    // ---------------------------------------------------------------- site
    const rewrite = new cloudfront.Function(this, 'Rewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var r = event.request;
  if (r.uri === '/register' || r.uri === '/register/') r.uri = '/register.html';
  return r;
}`)
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true }
      }
    });

    const dist = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Liahona Manager',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,     // small site; always fresh after a deploy
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(Fn.select(2, Fn.split('/', api.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders
        }
      }
    });
    const siteUrl = `https://${dist.distributionDomainName}`;

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'public'))],
      destinationBucket: siteBucket,
      distribution: dist,
      distributionPaths: ['/*'],
      prune: true
    });

    // ---------------------------------------------------------------- accounts
    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: 'liahona-manager',
      selfSignUpEnabled: false,                    // Admins invite people
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      passwordPolicy: { minLength: 10, requireLowercase: true, requireDigits: true, requireUppercase: false, requireSymbols: false,
        tempPasswordValidity: Duration.days(7) },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Your Liahona Manager account',
        emailBody: `You've been invited to help with camp in the Liahona Manager.<br><br>
Go to <a href="${siteUrl}">${siteUrl}</a> and sign in with<br>
email: {username}<br>temporary password: {####}<br><br>
You'll choose your own password the first time. This invite lasts 7 days.`
      },
      userVerification: {
        emailSubject: 'Your Liahona Manager code',
        emailBody: 'Your code is {####}'
      },
      removalPolicy: RemovalPolicy.RETAIN
    });

    for (const [name, description, precedence] of ROLES) {
      new cognito.CfnUserPoolGroup(this, `Group-${name}`, { userPoolId: pool.userPoolId, groupName: name, description, precedence });
    }

    const domainPrefix = `liahona-${this.account}`;
    pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI
    });
    const authDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    const client = pool.addClient('Web', {
      userPoolClientName: 'liahona-manager-web',
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteUrl}/`, 'http://localhost:3000/'],
        logoutUrls: [`${siteUrl}/`, 'http://localhost:3000/']
      }
    });

    fn.addEnvironment('USER_POOL_ID', pool.userPoolId);
    fn.addEnvironment('USER_POOL_CLIENT_ID', client.userPoolClientId);
    fn.addEnvironment('AUTH_DOMAIN', authDomain);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminUpdateUserAttributes'],
      resources: [pool.userPoolArn]
    }));

    // The first Admin (from the ADMIN_EMAIL setting). Cognito emails them a temporary password.
    if (adminEmail) {
      const first = new cognito.CfnUserPoolUser(this, 'FirstAdmin', {
        userPoolId: pool.userPoolId,
        username: adminEmail,
        desiredDeliveryMediums: ['EMAIL'],
        userAttributes: [{ name: 'email', value: adminEmail }, { name: 'email_verified', value: 'true' }]
      });
      const attach = new cognito.CfnUserPoolUserToGroupAttachment(this, 'FirstAdminGroup', {
        userPoolId: pool.userPoolId, groupName: 'admin', username: adminEmail
      });
      attach.node.addDependency(first);
      attach.node.addDependency(this.node.findChild('Group-admin'));
    }

    new CfnOutput(this, 'SiteUrl', { value: siteUrl, description: 'The manager' });
    new CfnOutput(this, 'SignUpForm', { value: `${siteUrl}/register`, description: 'Public sign-up form' });
    new CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
  }
}

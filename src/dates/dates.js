/*
 * Copyright (c) 2017, Hugo Freire <hugo@exec.sh>.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-disable camelcase */

const _ = require('lodash')
const Promise = require('bluebird')

const Logger = require('modern-logger')

const { NotAuthorizedError, OutOfLikesError } = require('../channels')
const { Recommendations, Channels } = require('../databases')

const Taste = require('./taste')
const { Recommendation, AlreadyCheckedOutEarlierError } = require('./recommendation')
const { Match } = require('./match')
const Stats = require('./stats')
const Channel = require('./channel')

const likeOrPass = (channel, recommendation, like, pass) => {
  if (like) {
    return Recommendation.like(channel, recommendation)
      .then((recommendation) => {
        recommendation.is_human_decision = false
        recommendation.decision_date = new Date()

        return recommendation
      })
  } else if (pass) {
    return Recommendation.pass(channel, recommendation)
      .then((recommendation) => {
        recommendation.is_human_decision = false
        recommendation.decision_date = new Date()

        return recommendation
      })
  }

  return Promise.resolve(recommendation)
}

class Dates {
  bootstrap () {
    return Promise.all([ Channel.bootstrap(), Taste.bootstrap() ])
  }

  find () {
    const findByChannel = function (channel) {
      return Logger.info(`Started finding dates in ${_.capitalize(channel.name)} channel`)
        .then(() => this.findByChannel(channel))
        .finally(() => Logger.info(`Finished finding dates in ${_.capitalize(channel.name)} channel`))
    }

    const updateStats = () => {
      return Logger.info('Started updating stats')
        .then(() => Stats.update())
        .finally(() => Logger.info('Finished updating stats'))
    }

    return Channels.findAll()
      .mapSeries((data) => {
        if (!data[ 'is_enabled' ]) {
          return
        }

        const channel = Channel.getByName(data[ 'name' ])

        return findByChannel.bind(this)(channel)
      })
      .then(() => updateStats())
  }

  findByChannel (channel) {
    const checkRecommendations = function (channel) {
      return Logger.info(`Started checking recommendations from ${_.capitalize(channel.name)} channel`)
        .then(() => this.checkRecommendations(channel))
        .then(({ received = 0, skipped = 0, failed = 0 }) => Logger.info(`Finished checking recommendations from ${_.capitalize(channel.name)} channel (received = ${received}, skipped = ${skipped}, failed = ${failed})`))
    }

    const checkUpdates = function (channel) {
      return Logger.info(`Started checking updates from ${_.capitalize(channel.name)} `)
        .then(() => this.checkUpdates(channel))
        .then(({ matches = 0, messages = 0 }) => Logger.info(`Finished checking updates from ${_.capitalize(channel.name)} (matches = ${matches}, messages = ${messages})`))
    }

    return checkRecommendations.bind(this)(channel)
      .then(() => checkUpdates.bind(this)(channel))
  }

  checkRecommendations (channel) {
    let received = 0
    let skipped = 0
    let failed = 0

    return channel.getRecommendations()
      .then((channelRecommendations) => {
        received = _.size(channelRecommendations)

        return Logger.debug(`Got ${received} recommendations from ${_.capitalize(channel.name)}`)
          .then(() => Promise.map(channelRecommendations, (channelRecommendation) => {
            const channelRecommendationId = channelRecommendation.channel_id

            return Recommendation.checkOut(channel, channelRecommendationId, channelRecommendation)
              .then(({ recommendation, like, pass }) => {
                return likeOrPass(channel, recommendation, like, pass)
                  .catch(OutOfLikesError, () => {
                    skipped++

                    return recommendation
                  })
              })
              .then((recommendation) => Recommendations.save([ recommendation.channel, recommendation.channel_id ], recommendation))
              .then(({ like, photos_similarity_mean, match, name }) => {
                if (match) {
                  return Logger.info(`${name} is a :fire:(photos = ${photos_similarity_mean}%)`)
                } else {
                  return Logger.info(`${name} got a ${like ? 'like :+1:' : 'pass :-1:'}(photos = ${photos_similarity_mean}%)`)
                }
              })
              .catch(AlreadyCheckedOutEarlierError, ({ recommendation }) => {
                skipped++

                return Recommendations.save([ recommendation.channel, recommendation.channel_id ], recommendation)
              })
              .catch((error) => {
                failed++

                return Logger.warn(error)
              })
          }, { concurrency: 1 }))
      })
      .then(() => { return { received, skipped, failed } })
      .catch(NotAuthorizedError, () => {
        return channel.authorize()
          .then(() => this.checkRecommendations(channel))
      })
      .catch((error) => Logger.error(error))
  }

  checkUpdates (channel) {
    return channel.getUpdates()
      .mapSeries((match) => {
        return Match.checkLatestNews(channel, match)
          .catch((error) => {
            Logger.warn(error)

            return { messages: 0, matches: 0 }
          })
      })
      .then((updates) => {
        return _.reduce(updates, (accumulator, update) => {
          accumulator.messages += update.messages
          accumulator.matches += update.matches
          return accumulator
        }, { messages: 0, matches: 0 })
      })
      .catch(NotAuthorizedError, () => {
        return channel.authorize()
          .then(() => this.checkUpdates(channel))
      })
      .catch((error) => Logger.error(error))
  }
}

module.exports = new Dates()

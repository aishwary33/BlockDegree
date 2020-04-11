const uuid = require("uuid/v4");
const _ = require("lodash");
const BitlyClient = require("bitly").BitlyClient;
const CoursePrice = require("../models/coursePrice");
const UserFundReq = require("../models/userFundRequest");
const User = require("../models/user");
const userCurrencyHelper = require("../helpers/userCurrency");
const profanityChecker = require("../helpers/profanityCheck");
const emailer = require("../emailer/impl");
const donationEm = require("../listeners/donationListener").em;
const xdc3 = require("../helpers/blockchainConnectors.js").rinkInst;
const cmcHelper = require("../helpers/cmcHelper");

const bitly = new BitlyClient(process.env.BITLY_ACCESS_TOKEN, {});

const minDescChar = 10,
  maxDescChar = 150;

exports.requestNewFund = async (req, res) => {
  try {
    const email = req.user ? req.user.email : "rudresh@xinfin.org";
    const description = req.body.desc;
    const courseId = JSON.parse(req.body.courseId);
    const facebookProfile = req.body.facebookProfile;
    const linkedinProfile = req.body.linkedinProfile;
    const twitterProfile = req.body.twitterProfile;
    let requiresApproval = false;
    let totalAmount = 0;

    const user = await User.findOne({ email: email });

    if (user === null) {
      return res.json({ status: false, error: "user not found" });
    }

    if (_.isEmpty(description.trim()) || courseId.length === 0) {
      return res.json({ status: false, error: "missing paramter(s)" });
    }

    const courseInsts = [];

    for (let i = 0; i < courseId.length; i++) {
      const currCourse = await CoursePrice.findOne({ courseId: courseId[i] });
      if (currCourse === null) {
        return res.json({ status: false, error: "course not found" });
      }
      if (user.examData.payment[currCourse.courseId] == true) {
        return res.json({ status: false, error: "course already bought" });
      }
      totalAmount += parseFloat(currCourse.priceUsd);
      courseInsts.push(currCourse);
    }

    // if (course === null) {
    //   return res.json({ status: false, error: "course not found" });
    // }

    // if (user.examData.payment[courseId] == true) {
    //   return res.json({ status: false, error: "course already bought" });
    // }

    if (description.length < minDescChar || description.length > maxDescChar) {
      return res.json({ status: false, error: "invalid description length" });
    }

    // const hasProfanity = await profanityChecker.checkForProfinity(description);

    // if (hasProfanity === true) {
    //   requiresApproval = true;
    // }

    const pendingRequest = await UserFundReq.findOne({
      $and: [
        {
          email: email,
        },
        { valid: true },
        { $or: [{ status: "uninitiated" }, { status: "pending" }] },
      ],
    });

    if (pendingRequest !== null) {
      return res.json({
        status: false,
        error: "cannot create more than one request at a time",
      });
    }

    const newAddr = userCurrencyHelper.createNewAddress();
    if (newAddr === null) {
      return res.json({ status: false, error: "internal error" });
    }

    const newFund = generateNewFund(
      email,
      description,
      parseFloat(totalAmount),
      newAddr.address,
      newAddr.privateKey,
      courseId,
      requiresApproval
    );

    const requestPath = `https://uat.blockdegree.org/fund-my-degree?fundId=${newFund.fundId}`;
    const shortUrl = await bitly.shorten(requestPath);
    newFund["requestUrlLong"] = requestPath;
    newFund["requestUrlShort"] = shortUrl.url;
    newFund["userName"] = user.name;

    if (!_.isEmpty(facebookProfile)) {
      newFund["socialProfile"]["facebook"] = facebookProfile;
    }
    if (!_.isEmpty(twitterProfile)) {
      newFund["socialProfile"]["twitter"] = twitterProfile;
    }
    if (!_.isEmpty(linkedinProfile)) {
      newFund["socialProfile"]["linkedin"] = linkedinProfile;
    }

    await newFund.save();
    res.json({
      status: true,
      message: "new fund request submitted",
      data: { shortUrl: shortUrl.url, longUrl: shortUrl.long_url },
    });

    donationEm.emit("syncRecipients");

    if (requiresApproval === true) {
      await emailer.sendMailInternal(
        "blockdegree-bot@blockdegree.org",
        process.env.SUPP_EMAIL_ID,
        "Admin Approval Requested",
        `Hello, we have found some profanity / vulgur in the description of the FMD with id ${newFund.fundId} by the user with email $${newFund.email} `
      );
    }
  } catch (e) {
    console.log(`exception at ${__filename}.requestNewFund: `, e);
    return res.json({ status: false, error: "internal error" });
  }
};

/**
 * will initiate a listener for a valid TX
 */
exports.initiateDonation = async (req, res) => {
  try {
    const reqTx = req.body.tx;
    const donerEmail = req.user ? req.user.email : "rudresh@xinfin.org";
    const fundId = req.body.fundId;

    if (_.isEmpty(reqTx) || _.isEmpty(donerEmail) || _.isEmpty(fundId)) {
      return null;
    }

    const fund = await UserFundReq.findOne({ fundId: fundId });

    if (fund.valid !== true) {
      return res.json({ status: false, error: "invalid funding" });
    }

    if (fund.status !== "uninitiated") {
      return res.json({ status: false, error: "funding already in progress" });
    }

    const doner = await User.findOne({ email: donerEmail });
    const priceUsd = parseFloat(fund.amountGoal);
    const existingTx = await UserFundReq.findOne({ fundTx: reqTx });

    if (existingTx !== null) {
      return res.json({ status: false, error: "invalid tx" });
    }

    const tx = await xdc3.eth.getTransaction(reqTx);
    if (tx !== null) {
      const valUsd = await cmcHelper.xdcToUsd(xdc3.utils.fromWei(tx.value));
      const min = priceUsd - (priceUsd * 10) / 10;
      const max = priceUsd + (priceUsd * 10) / 10;
      console.log(`min ${min} max ${max} valUsd ${valUsd}`);

      if (tx.to == fund.receiveAddr && min <= valUsd <= max) {
        // valid
        fund.fundTx = reqTx;
        fund.status = "pending";
        fund.donerEmail = donerEmail;
        fund.donerName = doner.name;
        await fund.save();
        donationEm.emit("processDonationTx", fundId, reqTx, doner.name);
        return res.json({ status: true, data: "listsner initiated" });
      } else {
        return res.json({ status: false, error: "invalid amount" });
      }
    } else {
      return res.json({ status: false, error: "invalid tx" });
    }
  } catch (e) {
    console.log(`exception at ${__filename}.initiateDonation: `, e);
    res.json({ status: false, error: "internal error" });
  }
};

/**
 * will return uninitiated funds, yet to get a fund
 */
exports.getUninitiatedFunds = async (req, res) => {
  try {
    const uninitiatedFunds = await UserFundReq.find({
      status: "uninitiated",
    })
      .select({ receiveAddrPrivKey: 0 })
      .lean();
    res.json({ status: true, data: uninitiatedFunds });
  } catch (e) {
    console.log(`exception at ${__filename}.getUninitiatedFunds`);
    res.json({ status: false, error: "internal error" });
  }
};

/**
 * will return all funds
 */
exports.getAllFunds = async (req, res) => {
  try {
    const uninitiatedFunds = await UserFundReq.find({
      $and: [
        {
          valid: true,
        },
        { status: { $not: /^pending$/ } },
      ],
    })
      .select({ receiveAddrPrivKey: 0 })
      .lean();
    res.json({ status: true, data: uninitiatedFunds });
  } catch (e) {
    console.log(`exception at ${__filename}.getAllFunds`, e);
    res.json({ status: false, error: "internal error" });
  }
};

/**
 *
 */
exports.getUserFundReq = async (req, res) => {
  try {
    const email = req.user ? req.user.email : "rudresh@xinfin.org";
    const userFmd = await UserFundReq.find({
      email: email,
    })
      .select({ receiveAddrPrivKey: 0 })
      .lean();
    res.json({ status: true, data: userFmd });
  } catch (e) {
    console.log(`exception at ${__filename}.getUserFundReq`);
    res.json({ status: false, error: "internal error" });
  }
};

/**
 * will return the cmc data
 */
exports.getCmcData = async (req, res) => {
  try {
  } catch (e) {
    console.log(`exception at ${__filename}.getCmcData: `, e);
    return res.json({ status: false, error: "internal error" });
  }
};

/**
 * will generate a model stub
 * @param {string} email
 * @param {Number} amountGoal
 * @param {string} recvAdd  r
 * @param {boolean=} approvalRequired
 */
function generateNewFund(
  email,
  description,
  amountGoal,
  recvAddr,
  recvAddrPrivKey,
  courseId,
  approvalRequired
) {
  return new UserFundReq({
    email: email,
    description: description,
    fundId: uuid(),
    courseId: courseId,
    amountGoal: amountGoal,
    amountReached: 0,
    approvalRequired: approvalRequired,
    valid: approvalRequired === false,
    receiveAddr: recvAddr,
    receiveAddrPrivKey: recvAddrPrivKey,
    fundTx: "",
    createdAt: Date.now() + "",
    updatedAt: Date.now() + "",
  });
}